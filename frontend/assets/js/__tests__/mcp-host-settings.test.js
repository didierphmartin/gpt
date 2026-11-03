const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const src = fs.readFileSync(__dirname + '/../settings-panel.js', 'utf8') + '\n;this.SettingsPanel = SettingsPanel;';

// A tiny DOM: the server row records what is inserted, the panel parses its own [data-value] inputs.
function makeEnv(stub) {
    const calls = { nameHtml: [], panels: [], notes: [] };
    const item = {
        classList: { add() {}, remove() {}, toggle() {} },
        _panel: null,
        querySelector(sel) {
            if (sel === '.mcp-server-name') return { insertAdjacentHTML: (_w, h) => calls.nameHtml.push(h) };
            if (sel === '.mcp-server-local') return item._panel && { remove() {} };
            return null;
        },
        appendChild(p) { item._panel = p; calls.panels.push(p); },
        remove() {},
    };
    const list = {
        querySelector: (sel) => (sel.includes('data-server-id="7"') ? item : null),
        querySelectorAll: () => [],
    };
    const document = {
        createElement() {
            const p = {
                _inputs: null, _handlers: {}, innerHTML: '',
                set className(_v) {},
                addEventListener() {},
                _make() {
                    if (!p._inputs) {
                        p._inputs = [...p.innerHTML.matchAll(/<input[^>]*data-value="([^"]+)"[^>]*>/g)]
                            .map((m) => ({ dataset: { value: m[1] }, value: (/\svalue="([^"]*)"/.exec(m[0]) || [, ''])[1], placeholder: '' }));
                    }
                    return p._inputs;
                },
                querySelectorAll(sel) { return sel === '[data-value]' ? p._make() : []; },
                querySelector(sel) {
                    if (sel === '[data-local-save]') return /data-local-save/.test(p.innerHTML) ? { addEventListener() {}, disabled: false } : null;
                    return null;
                },
            };
            return p;
        },
        getElementById: () => null,
        addEventListener() {},
    };
    const ctx = {
        window: {
            mcpClient: stub, WorkflowPackageUI: {
                settingsFieldsHtml: (_t, fields, vals) => fields.map((f) =>
                    `<input data-value="${f.name}" value="${vals[f.name] ?? ''}">`).join(''),
                wireCopyButtons() {}, toggleSecret() {},
            },
            i18n: { t: (k) => k },
        },
        document, console, confirm: () => true,
    };
    vm.createContext(ctx);
    vm.runInContext(src, ctx);
    const panel = Object.create(ctx.SettingsPanel.prototype);
    panel.mcpServerList = list;
    panel.myMcpEffective = new Map();
    panel.myMcpServers = [];
    panel.showNotification = (m, k) => calls.notes.push([k, m]);
    panel._refreshMcpMaster = () => {};
    panel.t = (k) => k;
    panel.loadMCPData = () => {};
    return { panel, calls, item, ctx };
}

const server = { id: 7, name: 'Outlook', url: 'http://localhost:8790/outlook_mcp/mcp', effective_on: true, user_id: 1 };
const makeStub = (over = {}) => {
    const stub = {
        saved: null, enabled: null, restarted: null, deleted: null, serverDeleted: null,
        servers: new Map(),
        hostStatus: async () => ({ available: true, gateway: 'http://localhost:8790' }),
        hostServers: async () => [{ folder: 'outlook_mcp', state: 'running', enabled: true }],
        hostSettings: async () => ({ fields: [
            { name: 'K', label: 'key', secret: true, required: true, filled: true },
            { name: 'N', label: 'n', required: true, filled: false },
        ] }),
        hostSaveSettings: async (f, v) => { stub.saved = [f, v]; return {}; },
        hostSetEnabled: async (f, e) => { stub.enabled = [f, e]; return {}; },
        hostRestart: async (f) => { stub.restarted = f; return {}; },
        hostDelete: async (f) => { stub.deleted = f; return {}; },
        getUserId: () => 1,
        toggles: [],
        toggleServer: async (i, on) => { stub.toggles.push(on); return { success: true }; },
        deleteServer: async () => { stub.serverDeleted = true; return { success: true }; },
        ...over,
    };
    return stub;
};

(async () => {
    // badge from host settings; a blank secret is never sent
    {
        const stub = makeStub();
        const { panel, calls, item } = makeEnv(stub);
        panel.myMcpServers = [server];
        await panel.refreshMCPLocal([server]);
        assert.match(calls.nameHtml.join(''), /⚠/);
        panel.showMCPLocalPanel(7);
        const p = item._panel;
        assert.match(p.innerHTML, /settings\.mcpHostState/);
        assert.match(p.innerHTML, /data-host-restart/);
        const inputs = p.querySelectorAll('[data-value]');
        assert.strictEqual(inputs.find((i) => i.dataset.value === 'K').placeholder, 'settings.mcpHostSecretSet');
        inputs.find((i) => i.dataset.value === 'N').value = 'x';
        await panel.saveMCPLocalSettings(7, p);
        assert.strictEqual(JSON.stringify(stub.saved), '["outlook_mcp",{"N":"x"}]');
    }
    // toggle off stops it
    {
        const stub = makeStub();
        const { panel } = makeEnv(stub);
        panel.myMcpServers = [server];
        await panel.refreshMCPLocal([server]);
        await panel.toggleMCPServer(7);
        assert.deepStrictEqual(stub.enabled, ['outlook_mcp', false]);
    }
    // delete also uninstalls
    {
        const stub = makeStub();
        const { panel } = makeEnv(stub);
        panel.myMcpServers = [server];
        await panel.refreshMCPLocal([server]);
        await panel.deleteMCPServer(7);
        assert.strictEqual(stub.serverDeleted, true);
        assert.strictEqual(stub.deleted, 'outlook_mcp');
    }
    // hostStatus throws: no host, nothing blocks, no host calls
    {
        const stub = makeStub({ hostStatus: async () => { throw new Error('HTTP 500: x'); } });
        const { panel, calls } = makeEnv(stub);
        panel.myMcpServers = [server];
        await panel.refreshMCPLocal([server]);
        await panel.toggleMCPServer(7);
        assert.strictEqual(calls.nameHtml.length, 0);
        assert.strictEqual(stub.enabled, null);
    }
    // no host: folder servers read as before (the localFs path, untouched)
    {
        const stub = makeStub({ hostStatus: async () => ({ available: false }) });
        const { panel, ctx } = makeEnv(stub);
        let read = false;
        panel._mcpFolderGranted = async () => true;
        panel._readMCPServerMap = async () => { read = true; return Object.create(null); };
        ctx.window.localFs = {}; ctx.window.WorkflowPackage = {};
        panel.myMcpServers = [server];
        await panel.refreshMCPLocal([server]);
        assert.ok(read, 'servers.json is read');
        assert.strictEqual(panel.mcpLocal.size, 0);
    }
    // restart is offered only for an enabled server
    {
        const stub = makeStub({ hostServers: async () => [{ folder: 'outlook_mcp', state: 'stopped', enabled: false }] });
        const { panel, item } = makeEnv(stub);
        panel.myMcpServers = [server];
        await panel.refreshMCPLocal([server]);
        panel.showMCPLocalPanel(7);
        assert.doesNotMatch(item._panel.innerHTML, /data-host-restart/);
    }
    // delete: uninstall first; failure aborts and keeps the registration, 404 counts as gone
    {
        const stub = makeStub({ hostDelete: async () => { throw Object.assign(new Error('HTTP 500: x'), { status: 500 }); } });
        const { panel, calls } = makeEnv(stub);
        panel.myMcpServers = [server];
        await panel.refreshMCPLocal([server]);
        await panel.deleteMCPServer(7);
        assert.strictEqual(stub.serverDeleted, null, 'registration kept');
        assert.strictEqual(calls.notes.at(-1)[0], 'error');
        const stub2 = makeStub({ hostDelete: async () => { throw Object.assign(new Error('HTTP 404: x'), { status: 404 }); } });
        const env2 = makeEnv(stub2);
        env2.panel.myMcpServers = [server];
        await env2.panel.refreshMCPLocal([server]);
        await env2.panel.deleteMCPServer(7);
        assert.strictEqual(stub2.serverDeleted, true);
    }
    // toggle: a failing host call reverts the switch and the registration
    {
        const stub = makeStub({ hostSetEnabled: async () => { throw new Error('HTTP 409: x'); } });
        const { panel, calls } = makeEnv(stub);
        panel.myMcpServers = [{ ...server }];
        await panel.refreshMCPLocal(panel.myMcpServers);
        await panel.toggleMCPServer(7);
        assert.strictEqual(JSON.stringify(stub.toggles), '[false,true]');
        assert.strictEqual(panel.myMcpServers[0].effective_on, true);
        assert.strictEqual(calls.notes.at(-1)[0], 'error');
    }
    // toggle: a server row someone else owns never reaches the supervisor
    {
        const stub = makeStub();
        const { panel } = makeEnv(stub);
        panel.myMcpServers = [{ ...server, user_id: 2 }];
        await panel.refreshMCPLocal(panel.myMcpServers);
        await panel.toggleMCPServer(7);
        assert.strictEqual(stub.enabled, null);
        const g = makeStub();
        const env = makeEnv(g);
        env.panel.myMcpServers = [{ ...server, user_id: null, is_global: true }];
        await env.panel.refreshMCPLocal(env.panel.myMcpServers);
        env.ctx.window.mcpClient.disableMyMcpServer = async () => ({ success: true });
        await env.panel.toggleMCPServer(7);
        assert.strictEqual(g.enabled, null);
    }
    // an unset field (value "" from the host) shows its default, and Save does not send it
    {
        const stub = makeStub({ hostSettings: async () => ({ fields: [
            { name: 'D', label: 'd', required: false, filled: false, value: '', default: 'dflt' },
        ] }) });
        const { panel, calls, item } = makeEnv(stub);
        panel.myMcpServers = [server];
        await panel.refreshMCPLocal([server]);
        panel.showMCPLocalPanel(7);
        assert.strictEqual(item._panel.querySelectorAll('[data-value]')[0].value, 'dflt');
        await panel.saveMCPLocalSettings(7, item._panel);
        assert.strictEqual(stub.saved, null);
    }
    // saving with nothing changed says so
    {
        const stub = makeStub();
        const { panel, calls, item } = makeEnv(stub);
        panel.myMcpServers = [server];
        await panel.refreshMCPLocal([server]);
        panel.showMCPLocalPanel(7);
        await panel.saveMCPLocalSettings(7, item._panel);
        assert.strictEqual(stub.saved, null);
        assert.deepStrictEqual(calls.notes.at(-1), ['info', 'settings.mcpHostNothingChanged']);
    }
    console.log('mcp-host-settings: ok');
})().catch((e) => { console.error(e); process.exit(1); });
