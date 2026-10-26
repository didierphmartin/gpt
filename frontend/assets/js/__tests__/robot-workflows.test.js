// Robot UI (task B5): publish a workflow, the robot's connections, the organization Connect.
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

    // publish 409 arms a confirm: the client POSTs /workflows/{id}/publish; a `replaces` answer arms, the second click confirms.
    const sent = [];
    let answer = { status: 409, body: { success: false, error: 'The robot is running "Mail"', kind: 'replaces' } };
    global.fetch = async (url, opts) => {
        sent.push({ url, method: opts.method, body: opts.body ? JSON.parse(opts.body) : undefined });
        return { status: answer.status, json: async () => answer.body };
    };
    const api = new PC.PlaybookApi('/api/v1', () => ({}));
    let state = PC.publishStep(null, { type: 'click', key: 75 });
    let err = null;
    try { await api.publishWorkflow(75, state.confirmReplace); } catch (e) { err = e; }
    assert.deepStrictEqual(sent[0], { url: '/api/v1/workflows/75/publish', method: 'POST', body: { confirm_replace: false } });
    assert.strictEqual(err.kind, 'replaces');
    state = PC.publishStep(state, { type: 'error', error: err, key: 75 }, undefined, 'robot.replaceConfirm');
    assert.strictEqual(state.armed, true);
    assert.strictEqual(state.message, "The robot is running this workflow: click again to replace it");
    assert.strictEqual(PC.publishStep(state, { type: 'click', key: 76 }).confirmReplace, false);
    state = PC.publishStep(state, { type: 'click', key: 75 });
    assert.strictEqual(state.confirmReplace, true);
    answer = { status: 200, body: { success: true, data: { robot_workflow_id: 120, replaced: true, needs_servers: ['Outlook'] } } };
    const ok = await api.publishWorkflow(75, state.confirmReplace);
    assert.deepStrictEqual(sent[1].body, { confirm_replace: true });
    assert.strictEqual(ok.data.robot_workflow_id, 120);
    // The playbook default message is unchanged.
    assert.ok(PC.publishStep(null, { type: 'error', error: { kind: 'replaces', data: { published_by: 'Ann' } }, key: 'k' }).message.startsWith('Replaces k published by Ann'));

    // needs_servers notice lists the names
    assert.strictEqual(PC.needsServersNotice([]), '');
    assert.strictEqual(PC.needsServersNotice(undefined), '');
    assert.strictEqual(PC.needsServersNotice(['Outlook', 'SharePoint']),
        'The robot needs these MCP connections: Outlook, SharePoint. Add them under Robot connections.');
    assert.strictEqual(PC.needsServersNotice(['A'], (k, p) => `${k}|${p.names}`), 'robot.needsServers|A');

    // The rest of the client: one method per robot route.
    sent.length = 0;
    answer = { status: 200, body: { success: true, data: [] } };
    await api.robotWorkflows();
    await api.unpublishWorkflow(120);
    await api.activateRobotWorkflow(120);
    await api.stopRobotWorkflow(120);
    await api.robotWorkflowRuns(120);
    await api.robotServers();
    await api.saveRobotServer({ name: 'Outlook', url: 'https://o/mcp', description: '' });
    await api.saveRobotServer({ id: 4, url: 'https://o2/mcp', enabled: false });
    await api.deleteRobotServer(4);
    await api.callRobotServer(4, 'whoami', {});
    await api.saveRobotKey(4, 'X-Conn', 'K');
    assert.deepStrictEqual(sent.map((s) => `${s.method} ${s.url}`), [
        'GET /api/v1/robot/workflows', 'DELETE /api/v1/robot/workflows/120',
        'POST /api/v1/robot/workflows/120/activate', 'DELETE /api/v1/robot/workflows/120/activate',
        'GET /api/v1/robot/workflows/120/executions?limit=20', 'GET /api/v1/robot/mcp-servers',
        'POST /api/v1/robot/mcp-servers', 'POST /api/v1/robot/mcp-servers/4', 'DELETE /api/v1/robot/mcp-servers/4',
        'POST /api/v1/robot/mcp-servers/4/call', 'POST /api/v1/robot/mcp-servers/4/key',
    ]);
    assert.deepStrictEqual(sent[6].body, { name: 'Outlook', url: 'https://o/mcp', description: '' });
    assert.deepStrictEqual(sent[7].body, { url: 'https://o2/mcp', enabled: false });
    assert.deepStrictEqual(sent[9].body, { tool: 'whoami', arguments: {} });
    assert.deepStrictEqual(sent[10].body, { header: 'X-Conn', key: 'K' });

    // A robot run in the results view's shape.
    const done = PC.runResultsData({ status: 'completed', output: '{"5":"filed"}', response_time_ms: 1200 });
    assert.deepStrictEqual(done, { success: true, output: '', node_outputs: { 5: 'filed' }, response_time_ms: 1200 });
    const failed = PC.runResultsData({ status: 'failed', error_message: 'no key', output: null });
    assert.deepStrictEqual(failed, { success: false, output: 'no key', node_outputs: {}, response_time_ms: 0 });

    console.log('robot-workflows: all passed');
})().catch((e) => { console.error(e); process.exit(1); });
