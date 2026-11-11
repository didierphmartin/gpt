/**
 * The code views and Info list the README.md a compile ships with: _singleFiles (the single-file JSON's script
 * plus its package_files) and _fillInfoReadme (Info's rendered README, per code structure). Extracts the REAL methods.
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
const src = [extract("    async _singleFiles(target = 'langgraph') {"),
    extract("    async _fillInfoReadme(backdrop, target = 'langgraph') {"),
    extract('    async _serverSettingsForDocs() {'), extract('    async _compileFetch(url) {')].join(',\n');

const PKG = [{ path: 'requirements.txt', code: 'x' }, { path: '.env.example', code: 'y' }, { path: 'README.md', code: '# Hello' }];
const g = globalThis;
g.bodies = [];
g.window = {};   // no settings readers: server_settings is []
g.fetch = async (url, init) => {
    g.fetched.push(url);
    g.bodies.push(init && init.body ? JSON.parse(init.body) : null);
    return { ok: true, json: async () => ({ success: true, data: { filename: 'wf_adk.py', code: 'print(1)', package_files: PKG } }) };
};

function makeEditor({ ingestion = false, mode = 'single', manifest = null } = {}) {
    const obj = eval('({ ' + src + ' })');
    return Object.assign(obj, {
        currentWorkflowId: 7, apiBase: '/api', t: (k) => k, getAuthHeaders: () => ({}),
        escapeHtml: (s) => String(s), _isIngestionWorkflow: () => ingestion,
        _persistIfDirty: async () => {}, _codegenOptions: () => ({ mode }),
        _fetchManifest: async (m, t) => { g.fetched.push(`manifest:${m}:${t}`); return manifest; },
        _manifestFileText: (f) => f.code, _pbRenderBody: (md) => `<p>${md}</p>`,
        _serverUsers: async () => new Map([['Outlook', ['Wait for mail', 'Save PDF']], ['Gone', ['X']]]),
        _loadMcpServersMeta: async () => [],
    });
}

/** A backdrop holding the .info-readme slot, with just what _fillInfoReadme touches. */
function makeBackdrop() {
    const body = { innerHTML: '' };
    const slot = { innerHTML: '', removed: false, remove() { this.removed = true; },
        querySelector: (s) => (s === '.markdown-content' ? body : null) };
    return { slot, body, querySelector: (s) => (s === '.info-readme' ? slot : null) };
}

(async () => {
    // single file: the script first, then the package files; LangGraph's endpoint is generate-python
    g.fetched = [];
    let files = await makeEditor()._singleFiles('adk');
    assert.deepStrictEqual(files.map((f) => f.path), ['wf_adk.py', 'requirements.txt', '.env.example', 'README.md']);
    assert.deepStrictEqual(g.fetched, ['/api/workflows/7/generate-adk']);
    g.fetched = [];
    await makeEditor()._singleFiles();
    assert.deepStrictEqual(g.fetched, ['/api/workflows/7/generate-python']);

    // an ingestion pipeline: the script only (its Store location saves the shown file)
    files = await makeEditor({ ingestion: true })._singleFiles('langgraph');
    assert.deepStrictEqual(files.map((f) => f.path), ['wf_adk.py']);

    // Info, single file: the README rendered in the slot
    let bd = makeBackdrop();
    await makeEditor()._fillInfoReadme(bd, 'maf');
    assert.ok(bd.slot.innerHTML.includes('readmeTitle'));
    assert.strictEqual(bd.body.innerHTML, '<p># Hello</p>');

    // Info, a package: the manifest's README for that target and mode
    g.fetched = [];
    bd = makeBackdrop();
    await makeEditor({ mode: 'a2a', manifest: { root: 'r', files: [{ path: 'README.md', code: 'A2A doc' }] } })._fillInfoReadme(bd, 'nooa');
    assert.deepStrictEqual(g.fetched, ['manifest:a2a:nooa']);
    assert.strictEqual(bd.body.innerHTML, '<p>A2A doc</p>');

    // no README / ingestion: the slot goes
    bd = makeBackdrop();
    await makeEditor({ mode: 'modular', manifest: { root: 'r', files: [] } })._fillInfoReadme(bd);
    assert.ok(bd.slot.removed);
    bd = makeBackdrop();
    await makeEditor({ ingestion: true })._fillInfoReadme(bd);
    assert.ok(bd.slot.removed);

    // the compile is a POST carrying each readable server's settings: nodes, plain values, secrets as names only
    g.window = {
        WorkflowPackage: { collectDependencies() {}, SECRET_FIELD_RE: /secret|token/i },
        McpServerSettings: { readAll: async (names) => [
            { name: 'Outlook', info: { host: false, values: { TENANT: 'contoso', APP_TOKEN: 'leak', CLIENT_SECRET: 'leak2' }, fields: [
                { name: 'TENANT', label: 'Tenant', required: true }, { name: 'APP_TOKEN' },
                { name: 'CLIENT_SECRET', secret: true }, { name: 'DROP_DIR' }] } },
            { name: 'Gone', info: { error: true, fields: [] } },
            { name: 'Hosted', info: { host: true, fields: [{ name: 'REGION', filled: true, value: 'eu' }, { name: 'MODE', filled: false }] } },
        ] },
    };
    g.bodies = [];
    await makeEditor()._singleFiles('adk');
    const sent = g.bodies[0].server_settings;
    assert.deepStrictEqual(sent.map((x) => x.name), ['Outlook', 'Hosted']);   // unreadable: left out
    assert.deepStrictEqual(sent[0].nodes, ['Wait for mail', 'Save PDF']);
    assert.deepStrictEqual(sent[0].fields, [
        { name: 'TENANT', label: 'Tenant', required: true, secret: false, value: 'contoso' },
        { name: 'APP_TOKEN', label: '', required: false, secret: true, value: '' },
        { name: 'CLIENT_SECRET', label: '', required: false, secret: true, value: '' },
        { name: 'DROP_DIR', label: '', required: false, secret: false, value: '' }]);
    assert.deepStrictEqual(sent[1].fields.map((f) => f.value), ['eu', '']);
    assert.ok(!JSON.stringify(g.bodies).includes('leak'));
    // an ingestion pipeline sends none
    g.bodies = [];
    await makeEditor({ ingestion: true })._singleFiles();
    assert.deepStrictEqual(g.bodies[0].server_settings, []);

    // a failed compile: said in the slot, bold
    g.fetch = async () => ({ ok: false, status: 500, text: async () => 'boom' });
    bd = makeBackdrop();
    await makeEditor()._fillInfoReadme(bd);
    assert.ok(bd.slot.innerHTML.includes('readmeFailed') && bd.slot.innerHTML.includes('boom') && bd.slot.innerHTML.includes('font-bold'));

    console.log('code-view-readme: all passed');
})().catch((e) => { console.error(e); process.exit(1); });
