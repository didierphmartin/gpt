/**
 * The server settings check in front of both run doors: the run conversation's turn (batch-conversation.test.js)
 * and ▶ on a scheduled / option Start, which activates the workflow (_activate). Extracts the REAL methods.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const file = fs.readFileSync(path.resolve(__dirname, '../workflow-editor.js'), 'utf8');
const END = '\n    }\n';
function extract(signature) {
    const start = file.indexOf(signature);
    if (start < 0) throw new Error('could not find: ' + signature.trim());
    return file.slice(start, file.indexOf(END, start) + END.length).trim();
}
const src = [extract('    async _activate() {'), extract('    async _runSettingsGate() {'),
    extract('    _serverSettingsSplit(nodeId, live) {')].join(',\n');

function makeEditor({ gate, nodes = [] } = {}) {
    const calls = [];
    const obj = eval('({ ' + src + ' })');
    Object.assign(obj, {
        calls, currentWorkflowId: 7, activeWorkflow: null, apiBase: '/api',
        t: (k) => k, getAuthHeaders: () => ({}),
        exportWorkflow: () => ({ nodes }),
        _persistIfDirty: async () => { calls.push('persist'); },
        _stopCompiledEngine: async () => {},
        _loadActive: async () => {},
        _showPrivateSkills: () => false,
        showNotification: (m) => calls.push('notify:' + m),
        _loadMcpServersMeta: async () => [{ name: 'Outlook', url: 'u' }],
    });
    if (gate) obj._runSettingsGate = gate;
    return obj;
}

const g = globalThis;
// the real settingsHomes / splitByHome, from mcp-server-settings.js
function vm_ms() {
    const ctx = { window: {}, console };
    ctx.self = ctx.window;
    require('vm').createContext(ctx);
    require('vm').runInContext(fs.readFileSync(path.resolve(__dirname, '../mcp-server-settings.js'), 'utf8'), ctx);
    const { settingsHomes, splitByHome } = ctx.window.McpServerSettings;
    Object.assign(g.window.McpServerSettings, { settingsHomes, splitByHome });
}
g.fetch = async (url, opts) => { g.fetched.push([url, opts && opts.method]); return { ok: true, json: async () => ({ success: true }) }; };

(async () => {
    // a cancelled settings form: not activated, nothing saved, no request
    g.fetched = [];
    let ed = makeEditor({ gate: async () => false });
    assert.strictEqual(await ed._activate(), false);
    assert.deepStrictEqual(g.fetched, []);
    assert.ok(!ed.calls.includes('persist'));

    // settings complete: activated
    g.fetched = [];
    ed = makeEditor({ gate: async () => true });
    assert.strictEqual(await ed._activate(), true);
    assert.deepStrictEqual(g.fetched, [['/api/workflows/7/activate', 'POST']]);

    // the real gate asks about the code nodes' servers AND the Start option component's servers
    let asked = null;
    g.window = {
        WorkflowPackage: { collectDependencies: (nodes) => ({ servers: ['SharePoint'] }) },
        WorkflowPackageUI: { settingsFieldsHtml() {}, loadServers: async () => ({ toolServers: new Map() }) },
        CodeComponents: { cache: { get: (id) => (id === 3 ? { mcp_servers: ['Outlook', 'SharePoint'] } : null) } },
        McpServerSettings: { runGate: async (_ed, names) => { asked = names; return true; } },
    };
    ed = makeEditor({ nodes: [{ node_type: 'start', config: { start_option: 3 } }, { node_type: 'code', config: {} }] });
    assert.strictEqual(await ed._runSettingsGate(), true);
    assert.deepStrictEqual(asked, ['SharePoint', 'Outlook']);

    // the check itself failing never blocks
    g.window.McpServerSettings.runGate = async () => { throw new Error('boom'); };
    assert.strictEqual(await ed._runSettingsGate(), true);

    // which node shows which server's settings (wf 75's shape): Outlook on the Start option, SharePoint on move
    vm_ms();
    ed = makeEditor();
    ed._startNodeId = () => '1';
    ed.editor = { drawflow: { drawflow: { Home: { data: {
        1: { data: { start_option: 3 }, outputs: { output_1: { connections: [{ node: '2' }] } } },
        2: { data: { name: 'PDF: convert document', mcp_servers: [] }, outputs: { output_1: { connections: [{ node: '4' }] } } },
        4: { data: { name: 'SharePoint: move', mcp_servers: ['SharePoint', 'Outlook'] }, outputs: {} },
    } } } } };
    g.window.CodeComponents.cache.get = (id) => (id === 3 ? { mcp_servers: ['Outlook'], start_trigger: { label: 'Outlook: On dropped email' } } : null);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(ed._serverSettingsSplit('4', ['SharePoint', 'Outlook']))),
        { here: ['SharePoint'], elsewhere: [{ name: 'Outlook', where: 'Outlook: On dropped email' }] });
    assert.deepStrictEqual(JSON.parse(JSON.stringify(ed._serverSettingsSplit('1', ['Outlook']))), { here: ['Outlook'], elsewhere: [] });
    console.log('run-settings-gate tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
