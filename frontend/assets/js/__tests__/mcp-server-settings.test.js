const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const ctx = { window: {}, console, TextEncoder, TextDecoder, URL };
ctx.self = ctx.window;
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(__dirname + '/../workflow-package.js', 'utf8'), ctx);
vm.runInContext(fs.readFileSync(__dirname + '/../mcp-server-settings.js', 'utf8'), ctx);
const MS = ctx.window.McpServerSettings;
const plain = (x) => JSON.parse(JSON.stringify(x));

// --- checkTargets: which used servers can be checked, and where ---
{
    const gw = 'http://gpt-host:8800/mcp-host';
    const metas = [
        { name: 'Outlook', url: 'http://127.0.0.1:8770/mcp' },
        { name: 'SharePoint', url: `${gw}/sharepoint_mcp/mcp` },
        { name: 'Remote', url: 'https://example.com/mcp' },
        { name: 'Off', url: 'http://127.0.0.1:9/mcp', effective_on: false },
        { name: 'Both', url: 'http://global/mcp', is_global: true },
        { name: 'Both', url: `${gw}/own_both/mcp` },
    ];
    const map = Object.assign(Object.create(null), { Outlook: 'outlook_mcp', Remote: undefined, Off: 'off_mcp', Bad: '../x' });
    assert.deepStrictEqual(plain(MS.checkTargets(['Outlook', 'SharePoint', 'Remote', 'Off', 'Unknown', 'Outlook', 'Both'], metas, map, gw)), [
        { name: 'Outlook', host: false, folder: 'outlook_mcp' },       // local: mapped folder
        { name: 'SharePoint', host: true, folder: 'sharepoint_mcp' },  // on the host gateway
        // Remote: URL only -> not checkable; Off: switched off; Unknown: not registered; duplicate Outlook once
        { name: 'Both', host: true, folder: 'own_both' },              // the user's own row wins over the global one
    ]);
    // no host: a gateway URL is just a URL; an unsafe folder in the map is ignored
    assert.deepStrictEqual(plain(MS.checkTargets(['SharePoint', 'Bad'], [...metas, { name: 'Bad', url: 'x' }], map, null)), []);
}

// --- sectionMissing: required fields still empty in the form ---
{
    const local = { host: false, fields: [{ name: 'A', required: true }, { name: 'B', required: false }, { name: 'C', required: true }] };
    assert.deepStrictEqual(plain(MS.sectionMissing(local, { A: ' ', B: '', C: 'x' })), ['A']);
    assert.deepStrictEqual(plain(MS.sectionMissing(local, { A: 'a', C: 'c' })), []);
    // host: a stored secret shows empty but is filled
    const host = { host: true, fields: [{ name: 'K', required: true, secret: true, filled: true }, { name: 'ID', required: true, filled: false }] };
    assert.deepStrictEqual(plain(MS.sectionMissing(host, { K: '', ID: '' })), ['ID']);
}

// --- groups: settings that go together ---
{
    const WP = ctx.window.WorkflowPackage;
    const fl = WP.envFields({ env: [{ name: 'ID', required: true }, { name: 'T', group: 'org' }, { name: 'G', group: 'org' }] }, '');
    assert.deepStrictEqual(plain(WP.missingRequired(fl, { ID: 'x' })), []);
    assert.deepStrictEqual(plain(WP.missingRequired(fl, { ID: 'x', T: 't' })), ['G']);
    assert.deepStrictEqual(plain(WP.missingRequired(fl, { T: 't', G: ' ' })), ['ID', 'G']);
    // host: a stored value counts; the form's empty secret input does not undo a stored secret
    const host = { host: true, fields: [{ name: 'T', group: 'org', filled: true }, { name: 'S', group: 'org', secret: true, filled: true },
        { name: 'G', group: 'org', filled: false }] };
    assert.deepStrictEqual(plain(MS.sectionMissing(host, { T: 'tenant', S: '', G: '' })), ['G']);
    assert.deepStrictEqual(plain(MS.sectionMissing(host, { T: '', S: '', G: '' })), ['T', 'G']);   // cleared in the form: needed again
}

// --- findMissing over a fake SynergyAI folder: only servers with a required setting empty ---
(async () => {
    const files = {
        'mcps/servers.json': JSON.stringify({ Outlook: 'outlook_mcp', SharePoint: 'sharepoint_mcp' }),
        'mcps/outlook_mcp/synergyai-mcp.json': JSON.stringify({ start: './run.sh', env: [
            { name: 'OUTLOOK_CLIENT_ID', required: true }, { name: 'OUTLOOK_SECRET_KEY', required: true, secret: true },
            { name: 'OUTLOOK_PORT', default: '8770' }] }),
        'mcps/outlook_mcp/.env': 'OUTLOOK_CLIENT_ID=abc\n# keep me\nOTHER=1\n',
        'mcps/sharepoint_mcp/synergyai-mcp.json': JSON.stringify({ env: [{ name: 'SHAREPOINT_CLIENT_ID', required: true }] }),
        'mcps/sharepoint_mcp/.env': 'SHAREPOINT_CLIENT_ID=ok\n',
    };
    const written = {};
    ctx.window.localFs = {
        getStatus: async () => ({ state: 'granted' }),
        resolvePath: async (p, o) => {
            if (!(p in files) && !(o && o.create)) return null;
            return { getFile: async () => ({ text: async () => files[p] }),
                createWritable: async () => ({ write: async (t) => { written[p] = t; files[p] = t; }, close: async () => {} }) };
        },
    };
    ctx.window.mcpClient = { hostStatus: async () => ({ available: false }) };
    const metas = [{ name: 'Outlook', url: 'http://127.0.0.1:8770/mcp' }, { name: 'SharePoint', url: 'http://127.0.0.1:8771/mcp' }];

    // readAll: every checkable server, complete or not (the component form lists them all)
    const all = await MS.readAll(['Outlook', 'SharePoint', 'Remote'], [...metas, { name: 'Remote', url: 'https://x/mcp' }]);
    assert.deepStrictEqual(plain(all.map((r) => [r.name, r.info.missing])), [['Outlook', ['OUTLOOK_SECRET_KEY']], ['SharePoint', []]]);

    const missing = await MS.findMissing(['Outlook', 'SharePoint'], metas);
    assert.strictEqual(missing.length, 1);
    assert.strictEqual(missing[0].name, 'Outlook');
    assert.deepStrictEqual(plain(missing[0].info.missing), ['OUTLOOK_SECRET_KEY']);
    assert.strictEqual(missing[0].info.manifest.start, './run.sh');

    // saving keeps the file's other lines and clears the missing list
    await MS.saveLocal(missing[0].info, { OUTLOOK_CLIENT_ID: 'abc', OUTLOOK_SECRET_KEY: 'k', OUTLOOK_PORT: '8770' });
    assert.match(written['mcps/outlook_mcp/.env'], /# keep me/);
    assert.match(written['mcps/outlook_mcp/.env'], /OTHER=1/);
    assert.match(written['mcps/outlook_mcp/.env'], /OUTLOOK_SECRET_KEY=k/);
    assert.deepStrictEqual(plain(missing[0].info.missing), []);
    assert.deepStrictEqual(plain(await MS.findMissing(['Outlook', 'SharePoint'], metas)), []);

    // no folder access: nothing local can be checked, so nothing blocks
    ctx.window.localFs.getStatus = async () => ({ state: 'prompt' });
    delete files['mcps/outlook_mcp/.env'];
    assert.deepStrictEqual(plain(await MS.findMissing(['Outlook'], metas)), []);
    ctx.window.localFs.getStatus = async () => ({ state: 'granted' });

    // host server: only the changed values are sent
    const sent = [];
    ctx.window.mcpClient = {
        hostStatus: async () => ({ available: true, gateway: 'http://gw' }),
        hostServers: async () => [{ folder: 'sp', state: 'running' }],
        hostSettings: async () => ({ fields: [{ name: 'SP_ID', required: true, filled: false, default: '' },
            { name: 'SP_KEY', required: true, secret: true, filled: true }, { name: 'SP_PORT', default: '1' }] }),
        hostSaveSettings: async (f, v) => { sent.push([f, v]); },
    };
    const hm = await MS.findMissing(['SP'], [{ name: 'SP', url: 'http://gw/sp/mcp' }]);
    assert.strictEqual(hm.length, 1);
    assert.deepStrictEqual(plain(hm[0].info.missing), ['SP_ID']);
    assert.ok(!hm[0].info.fields.some((f) => f.name === 'SP_PORT'));   // set by the supervisor: hidden
    assert.strictEqual(await MS.saveHost(hm[0].info, { SP_ID: 'id', SP_KEY: '' }), 1);
    assert.deepStrictEqual(plain(sent), [['sp', { SP_ID: 'id' }]]);

    // the settings list: checked, compact, written into the manifest keeping its other keys
    assert.deepStrictEqual(plain(MS.cleanList([{ name: ' A_ID ', label: ' Id ', required: true, secret: false, default: '', group: '' },
        { name: 'A_KEY', label: '', required: false, secret: true, default: 'x', group: ' org ' }])),
        { env: [{ name: 'A_ID', label: 'Id', required: true, secret: false }, { name: 'A_KEY', secret: true, default: 'x', group: 'org' }] });
    assert.deepStrictEqual(plain(MS.cleanList([{ name: '1A' }])), { error: { key: 'listBadName', params: { n: 1, name: '1A' } } });
    assert.deepStrictEqual(plain(MS.cleanList([{ name: 'A' }, { name: 'A' }])), { error: { key: 'listTwice', params: { name: 'A' } } });
    const loc = await MS.readLocalInfo('outlook_mcp');
    assert.deepStrictEqual(plain(MS.listOf(loc).map((f) => f.name)), ['OUTLOOK_CLIENT_ID', 'OUTLOOK_SECRET_KEY', 'OUTLOOK_PORT']);
    await MS.saveListLocal(loc, [{ name: 'NEW', required: true, secret: false }]);
    const man = JSON.parse(files['mcps/outlook_mcp/synergyai-mcp.json']);
    assert.strictEqual(man.start, './run.sh');
    assert.deepStrictEqual(man.env, [{ name: 'NEW', required: true, secret: false }]);
    files['mcps/outlook_mcp/synergyai-mcp.json'] = '{broken';
    await assert.rejects(MS.saveListLocal(loc, []), /not a JSON object/);
    assert.strictEqual(files['mcps/outlook_mcp/synergyai-mcp.json'], '{broken');   // never overwritten
    // host: the editor starts from the whole list, the supervisor's host/port included
    assert.ok(MS.listOf(hm[0].info).some((f) => f.name === 'SP_PORT'));

    // nothing used: nothing read
    assert.deepStrictEqual(plain(await MS.findMissing([], [])), []);
    console.log('mcp-server-settings tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
