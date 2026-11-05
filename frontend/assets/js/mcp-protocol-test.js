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

    const DEFAULT_LABELS = {
        run: 'Run test', running: 'Running…', copyReport: 'Copy report', copied: 'Copied',
        idle: 'Press Run test to check how this server speaks MCP.',
        handshake: 'Handshake', serverInfo: 'Server information', validation: 'Protocol validation',
        resourcesPrompts: 'Resources & prompts', activityLog: 'Activity log',
        resources: 'Resources', prompts: 'Prompts', none: 'None',
        name: 'Name', version: 'Version', requested: 'Protocol requested', negotiated: 'Protocol negotiated',
        capabilities: 'Capabilities', instructions: 'Instructions',
        summary: '{passed} passed, {warnings} warnings, {errors} errors',
        request: 'request', response: 'response', raw: 'raw JSON', noValidation: 'No validation ran.',
        registryNotTested: 'Run the test to check the MCP Registry',
        registryRegistered: 'Registered in the MCP Registry: {name} v{version}, active',
        registryDeprecated: 'Registered in the MCP Registry, deprecated: {name} v{version}',
        registryNotRegistered: 'Not registered in the MCP Registry',
        registryUnreachable: 'MCP Registry unreachable',
        stepInitialize: 'initialize', stepInitializeMcp: 'initialize (at /mcp)', stepInitialized: 'notifications/initialized',
        stepTools: 'tools/list', stepResources: 'resources/list', stepPrompts: 'prompts/list',
    };
    const STEP_LABEL = { initialize: 'stepInitialize', 'initialize-mcp': 'stepInitializeMcp', initialized: 'stepInitialized', tools: 'stepTools', resources: 'stepResources', prompts: 'stepPrompts' };
    const ICON = { ok: '✅', warn: '⚠️', error: '❌', skipped: '⏭' };
    const fmt = (t, o) => String(t).replace(/\{(\w+)\}/g, (m, k) => (o && o[k] != null ? o[k] : m));

    function normaliseUrl(u) {
        let x;
        try { x = new URL(String(u).trim()); } catch (e) { return String(u || '').trim().toLowerCase().replace(/\/+$/, ''); }
        return x.origin + x.pathname.replace(/\/+$/, '') + x.search;
    }

    const REGISTRY = 'https://registry.modelcontextprotocol.io/v0/servers?search=';
    const DAY = 24 * 3600 * 1000;
    async function registryStatus(name, url, fetchFn, now) {
        if (!name) return { state: 'not-registered' };
        now = now == null ? Date.now() : now;
        const ls = typeof localStorage !== 'undefined' ? localStorage : null;
        const key = 'mcpRegistry:' + normaliseUrl(url);
        if (ls) {
            try {
                const c = JSON.parse(ls.getItem(key));
                if (c && c.result && now - c.at < DAY) return c.result;
            } catch (e) { /* ignore a bad cache entry */ }
        }
        const link = REGISTRY + encodeURIComponent(name);
        let result;
        try {
            const data = await fetchFn(link);
            const want = normaliseUrl(url);
            const hit = ((data && data.servers) || []).map(e => ({ s: (e && e.server) || e || {}, m: e && e._meta })).find(e =>
                (e.s.remotes || []).some(r => r && r.url && normaliseUrl(r.url) === want));
            if (!hit) result = { state: 'not-registered' };
            else {
                const m = (hit.m || hit.s._meta || {})['io.modelcontextprotocol.registry/official'] || {};
                result = { state: m.status === 'deprecated' ? 'deprecated' : 'registered', name: hit.s.name, version: hit.s.version, link };
            }
        } catch (e) { return { state: 'unreachable' }; }
        if (ls) { try { ls.setItem(key, JSON.stringify({ at: now, result })); } catch (e) { /* quota */ } }
        return result;
    }

    function counts(report) {
        const c = { passed: 0, warnings: 0, errors: 0 };
        report.validation.forEach(v => { if (v.errors.length) c.errors += v.errors.length; else c.passed++; c.warnings += v.warnings.length; });
        return c;
    }

    function reportText(report, labels) {
        const L = Object.assign({}, DEFAULT_LABELS, labels);
        const out = [];
        const sv = report.server;
        if (sv) out.push(`${sv.name || ''} ${sv.version || ''}`.trim() + ` (${sv.negotiated || ''})`);
        out.push(fmt(L.summary, counts(report)));
        if (report.urlWarning) out.push(report.urlWarning);
        if (report.transportNote) out.push(report.transportNote);
        report.steps.forEach(s => out.push(`${ICON[s.status] || ''} ${s.id}${s.http ? ' HTTP ' + s.http : ''}${s.ms != null ? ' ' + s.ms + ' ms' : ''}${s.note ? ' - ' + s.note : ''}`));
        report.validation.forEach(v => {
            v.errors.forEach(e => out.push(`${ICON.error} ${v.context}: ${e}`));
            v.warnings.forEach(w => out.push(`${ICON.warn} ${v.context}: ${w}`));
        });
        return out.join('\n');
    }

    // ---- view ----
    function mount(el, opts) {
        opts = opts || {};
        const L = Object.assign({}, DEFAULT_LABELS, opts.labels);
        const doc = el.ownerDocument;
        let running = false, destroyed = false, last = null;
        const extra = [];
        const mk = (tag, cls, text) => { const n = doc.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
        const json = v => { try { return JSON.stringify(v, null, 2); } catch (e) { return String(v); } };

        el.textContent = '';
        el.classList.add('mpt');
        const bar = mk('div', 'mpt-bar');
        const runBtn = mk('button', 'mpt-btn mpt-run', L.run); runBtn.type = 'button';
        const copyBtn = mk('button', 'mpt-btn', L.copyReport); copyBtn.type = 'button'; copyBtn.disabled = true;
        bar.append(runBtn, copyBtn);
        const body = mk('div', 'mpt-body');
        el.append(bar, body);

        const section = (title, ...kids) => { const s = mk('section', 'mpt-section'); s.append(mk('h4', 'mpt-h', title), ...kids); return s; };
        const row = (k, v) => { const r = mk('div', 'mpt-kv'); r.append(mk('span', 'mpt-k', k), mk('span', 'mpt-v', v == null || v === '' ? '-' : String(v))); return r; };
        const logLine = e => {
            const d = mk('details', 'mpt-log-entry mpt-' + e.direction);
            d.append(mk('summary', '', `${e.at} ${e.step} ${e.direction === 'request' ? L.request : L.response}`), mk('pre', 'mpt-pre', json(e.body)));
            return d;
        };
        const logBox = mk('div', 'mpt-log');

        function render(report) {
            body.textContent = '';
            if (!report) { body.append(mk('p', 'mpt-idle', L.idle)); return; }
            const hs = mk('ul', 'mpt-steps');
            report.steps.forEach(s => {
                const li = mk('li', 'mpt-step mpt-' + s.status);
                li.append(mk('span', 'mpt-icon', ICON[s.status] || ''), mk('span', 'mpt-step-id', L[STEP_LABEL[s.id]] || s.id));
                if (s.http) li.append(mk('span', 'mpt-meta', 'HTTP ' + s.http));
                if (s.ms != null) li.append(mk('span', 'mpt-meta', s.ms + ' ms'));
                if (s.note) li.append(mk('span', 'mpt-note', s.note));
                hs.append(li);
            });
            const hsKids = [hs];
            if (report.urlWarning) hsKids.unshift(mk('p', 'mpt-warn', report.urlWarning));
            if (report.transportNote) hsKids.unshift(mk('p', 'mpt-note', report.transportNote));
            body.append(section(L.handshake, ...hsKids));

            if (report.server) {
                const sv = report.server, kids = [row(L.name, sv.name), row(L.version, sv.version), row(L.requested, sv.requested), row(L.negotiated, sv.negotiated)];
                const cd = mk('details', 'mpt-caps'); cd.append(mk('summary', '', L.capabilities), mk('pre', 'mpt-pre', json(sv.capabilities)));
                kids.push(cd);
                if (sv.instructions) kids.push(mk('div', 'mpt-instr', sv.instructions));
                body.append(section(L.serverInfo, ...kids));
            }

            const vk = [];
            if (!report.validation.length) vk.push(mk('p', 'mpt-idle', L.noValidation));
            else {
                vk.push(mk('p', 'mpt-summary', fmt(L.summary, counts(report))));
                report.validation.forEach(v => {
                    v.errors.forEach(e => vk.push(mk('div', 'mpt-issue mpt-error', `${ICON.error} ${v.context}: ${e}`)));
                    v.warnings.forEach(w => vk.push(mk('div', 'mpt-issue mpt-warn', `${ICON.warn} ${v.context}: ${w}`)));
                });
            }
            body.append(section(L.validation, ...vk));

            const list = (title, items, fn) => {
                const g = mk('div', 'mpt-group'); g.append(mk('h5', 'mpt-h5', title));
                if (!items.length) g.append(mk('p', 'mpt-idle', L.none));
                items.forEach(i => g.append(fn(i)));
                return g;
            };
            body.append(section(L.resourcesPrompts,
                list(L.resources, report.resources, r => mk('div', 'mpt-item', [r.name, r.uri, r.description].filter(Boolean).join(' - '))),
                list(L.prompts, report.prompts, p => mk('div', 'mpt-item', [p.name, (p.arguments || []).map(a => a.name).join(', '), p.description].filter(Boolean).join(' - ')))));

            logBox.textContent = '';
            report.log.concat(extra).forEach(e => logBox.append(logLine(e)));
            body.append(section(L.activityLog, logBox));
        }

        async function run() {
            if (destroyed) return last;
            if (running) return last;
            running = true; runBtn.disabled = true; runBtn.textContent = L.running;
            let report = null;
            try {
                report = await runTest(opts.send, { transport: opts.transport, url: opts.url, Validator: opts.Validator });
                last = report; extra.length = 0;
                if (!destroyed) { render(report); copyBtn.disabled = false; }
                if (opts.onReport) { try { opts.onReport(report); } catch (e) { /* caller's problem */ } }
            } finally {
                running = false;
                if (!destroyed) { runBtn.disabled = false; runBtn.textContent = L.run; }
            }
            return report;
        }
        function log(entry) {
            if (destroyed || !entry) return;
            extra.push(entry);
            if (last) logBox.append(logLine(entry));
        }
        async function copy() {
            if (!last) return;
            const text = reportText(last, L);
            try {
                if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
                    await navigator.clipboard.writeText(text);
                    copyBtn.textContent = L.copied; setTimeout(() => { if (!destroyed) copyBtn.textContent = L.copyReport; }, 1500);
                    return;
                }
            } catch (e) { /* fall through to the textarea */ }
            try {
                const ta = mk('textarea', 'mpt-copy'); ta.readOnly = true; ta.value = text; ta.rows = 8;
                bar.after(ta); ta.focus(); ta.select();
            } catch (e) { /* never throw */ }
        }
        runBtn.addEventListener('click', () => { run(); });
        copyBtn.addEventListener('click', copy);
        render(null);
        return {
            run, log,
            destroy() { destroyed = true; el.textContent = ''; el.classList.remove('mpt'); },
        };
    }

    return { runTest, mount, reportText, normaliseUrl, registryStatus, DEFAULT_LABELS };
});
