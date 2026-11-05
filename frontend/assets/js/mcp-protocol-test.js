/**
 * MCP protocol test (port of MCPeek's protocol view). runTest drives the MCP handshake through an injected
 * `send(message, {sessionId, protocolVersion, sibling}) -> Relay` and builds a Report; it never throws.
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.McpProtocolTest = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    const SSE_NOTE = "Transport SSE: tested the way SynergyAI reaches it (Streamable HTTP at the server's /mcp endpoint).";

    async function runTest(send, opts) {
        opts = opts || {};
        const Validator = opts.Validator || (typeof window !== 'undefined' ? window.MCPProtocolValidator : undefined);
        const validator = new Validator(Validator.LATEST_VERSION);
        const report = {
            steps: [], server: null, validation: [], resources: [], prompts: [], log: [],
            urlWarning: null,
            transportNote: opts.transport === 'sse' ? SSE_NOTE : null,
        };
        let nextId = 1;
        const ctx = { sessionId: null, protocolVersion: null, sibling: false };

        const logEntry = (step, direction, body) =>
            report.log.push({ at: new Date().toISOString(), step, direction, body });

        // One request/notification; returns {relay, response} where response is the message answering `id`.
        async function call(step, method, params, notify) {
            const message = { jsonrpc: '2.0', method };
            if (!notify) message.id = nextId++;
            if (params) message.params = params;
            logEntry(step, 'request', message);
            let relay;
            try { relay = await send(message, { sessionId: ctx.sessionId, protocolVersion: ctx.protocolVersion, sibling: ctx.sibling }); }
            catch (e) { relay = { error: String((e && e.message) || e) }; }
            relay = relay || { error: 'no answer' };
            logEntry(step, 'response', relay.messages && relay.messages.length ? relay.messages : (relay.body || relay.error || ''));
            const response = notify ? null : (relay.messages || []).find(m => m && m.id === message.id) || null;
            return { relay, response };
        }
        const stepOf = (id, status, relay, note) => ({
            id, status, http: relay && relay.status ? relay.status : null,
            ms: relay && typeof relay.duration_ms === 'number' ? relay.duration_ms : null, note: note || '',
        });
        const validate = (context, fn, response) => {
            const v = validator[fn](response) || {};
            const errors = v.errors || [], warnings = v.warnings || [];
            report.validation.push({ context, valid: errors.length === 0 && v.valid !== false, errors, warnings });
            return { errors, warnings };
        };
        const skipFrom = (ids, note) => ids.forEach(id => report.steps.push(stepOf(id, 'skipped', null, note)));
        const rpcError = r => r && r.error ? `${r.error.code}: ${r.error.message}` : null;

        // --- initialize
        const initParams = {
            protocolVersion: Validator.LATEST_VERSION, capabilities: {},
            clientInfo: { name: 'SynergyAI MCP Test', version: '1.0.0' },
        };
        let init = await call('initialize', 'initialize', initParams);
        let initId = 'initialize';
        const url = String(opts.url || '').replace(/\/+$/, '');
        if (opts.transport !== 'sse' && !init.relay.error && !init.response) {
            const note = init.relay.status ? `no MCP answer at the registered URL (HTTP ${init.relay.status})` : 'no MCP answer at the registered URL';
            report.steps.push(stepOf('initialize', 'warn', init.relay, note));
            ctx.sibling = true;
            init = await call('initialize-mcp', 'initialize', initParams);
            initId = 'initialize-mcp';
            if (init.response && !init.response.error) {
                report.urlWarning = `The server answers at ${url}/mcp; the registered URL is ${url}.`;
            }
        }
        const rest = ['initialized', 'tools', 'resources', 'prompts'];
        let initFail = null;
        if (init.relay.error) initFail = init.relay.error;
        else if (!init.response) initFail = 'no JSON-RPC answer to initialize';
        else if (init.response.error) initFail = rpcError(init.response);
        if (initFail) {
            report.steps.push(stepOf(initId, 'error', init.relay, initFail));
            skipFrom(rest, 'skipped (initialize failed)');
            return report;
        }
        const sid = init.relay.headers && init.relay.headers['mcp-session-id'];
        ctx.sessionId = sid || null;
        const result = init.response.result || {};
        ctx.protocolVersion = result.protocolVersion || null;
        const caps = result.capabilities || {};
        report.server = {
            name: result.serverInfo && result.serverInfo.name, version: result.serverInfo && result.serverInfo.version,
            requested: Validator.LATEST_VERSION, negotiated: result.protocolVersion,
            capabilities: caps, instructions: result.instructions,
        };
        {
            const v = validate('initialize', 'validateInitializeResponse', init.response);
            report.steps.push(stepOf(initId, v.errors.length ? 'error' : v.warnings.length ? 'warn' : 'ok', init.relay, v.errors[0] || v.warnings[0] || ''));
        }

        // --- notifications/initialized
        {
            const n = await call('initialized', 'notifications/initialized', null, true);
            const bad = n.relay.error || (n.relay.status >= 400 ? `HTTP ${n.relay.status}` : null);
            report.steps.push(stepOf('initialized', bad ? 'error' : 'ok', n.relay, bad || ''));
        }

        // --- list steps
        const lists = [
            ['tools', 'tools/list', 'validateToolsListResponse', null],
            ['resources', 'resources/list', 'validateResourcesListResponse', report.resources],
            ['prompts', 'prompts/list', 'validatePromptsListResponse', report.prompts],
        ];
        for (const [id, method, fn, sink] of lists) {
            if (!caps[id]) { report.steps.push(stepOf(id, 'skipped', null, 'not offered')); continue; }
            const r = await call(id, method);
            const fail = r.relay.error || (!r.response ? 'no JSON-RPC answer' : rpcError(r.response));
            if (fail) { report.steps.push(stepOf(id, 'error', r.relay, fail)); continue; }
            if (sink) sink.push(...((r.response.result && r.response.result[id]) || []));
            const v = validate(method, fn, r.response);
            report.steps.push(stepOf(id, v.errors.length ? 'error' : v.warnings.length ? 'warn' : 'ok', r.relay, v.errors[0] || v.warnings[0] || ''));
        }
        return report;
    }

    return { runTest };
});
