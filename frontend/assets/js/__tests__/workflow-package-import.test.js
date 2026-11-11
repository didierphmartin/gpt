const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const src = fs.readFileSync(__dirname + '/../workflow-package-import.js', 'utf8');

// The result panel only: the module needs WorkflowPackageUI.esc at load and nothing else.
const ctx = { window: { WorkflowPackageUI: { esc: (x) => String(x) } }, console, setTimeout, btoa, URL };
vm.createContext(ctx);
vm.runInContext(src, ctx);
const resultHtml = ctx.window.WorkflowPackageUI.importResultHtml;
const editor = { t: (k) => k };
const html = (state, log) => resultHtml(editor, { rows: [], values: {} },
    { installed: [{ kind: 'server', name: 'Outlook', destination: 'volume: outlook_mcp', state, log }], commands: [] });

// "starting" means it stopped and waits to be started again: not a success, and its log shows
assert.match(html('starting', ['boom']), /workflow\.package\.hostRestarting[\s\S]*boom/);
assert.doesNotMatch(html('starting', ['boom']), /hostRunning/);
assert.doesNotMatch(html('running', ['fine']), /fine/);
assert.match(html('running'), /workflow\.package\.hostRunning/);
assert.match(html('crashed', ['boom']), /hostInstallFailed[\s\S]*boom/);

// the host install wrapper hands the GitHub source on; the shared registrationUrl is the io's
{
    const calls = [];
    ctx.window.McpHostInstall = { installOnHost: async (f, b) => { calls.push([f, b]); return { state: 'running' }; }, registrationUrl: () => 'R' };
    ctx.window.WorkflowPackageUI.importIo(editor).installServer('srv', { name: 'S', files: { 'a.php': new Uint8Array([65]) }, env: {}, source: { owner: 'o' } });
    assert.deepStrictEqual(JSON.parse(JSON.stringify(calls[0][1])), { name: 'S', filesB64: { 'a.php': 'QQ==' }, env: {}, source: { owner: 'o' } });
    assert.strictEqual(ctx.window.WorkflowPackageUI.importIo(editor).registrationUrl('g', 'f', {}), 'R');
}

// a server row with a GitHub source says where it came from: "from <owner>/<repo> @ <sha7>"
{
    const ted = { t: (k, p) => (k === 'mcpLibrary.import.from' ? `from ${p.source}` : k) };
    const row = { kind: 'server', name: 'Php', status: 'install', reasons: [], choice: null, destination: 'mcps/php_srv', volume: true,
        source: { url: 'https://github.com/o/r', owner: 'o', repo: 'r', ref: 'main', sha: '0123456789abcdef', path: 'srv' } };
    const card = ctx.window.WorkflowPackageUI.importCardHtml(ted, { rows: [row], values: {} }, row, 0);
    assert.match(card, /from o\/r @ 0123456/);
    assert.doesNotMatch(card, /0123456789/);
    const plain = ctx.window.WorkflowPackageUI.importCardHtml(ted, { rows: [], values: {} }, { ...row, source: undefined }, 0);
    assert.doesNotMatch(plain, /from /);
}
console.log('workflow-package-import: ok');

// a GitHub link to a package .zip -> its raw.githubusercontent.com address; anything else is refused
{
    const U = ctx.window.WorkflowPackageUI.packageLinkUrl;
    const RAW = 'https://raw.githubusercontent.com/didierphmartin/workflows/main/Move_Email_to_Sharepoint.zip';
    assert.strictEqual(U('https://github.com/didierphmartin/workflows/blob/main/Move_Email_to_Sharepoint.zip'), RAW);
    assert.strictEqual(U('  https://github.com/didierphmartin/workflows/blob/main/Move_Email_to_Sharepoint.zip?raw=true '), RAW);
    assert.strictEqual(U('https://github.com/didierphmartin/workflows/raw/main/Move_Email_to_Sharepoint.zip'), RAW);
    assert.strictEqual(U(RAW), RAW);
    assert.strictEqual(U('https://github.com/o/r/blob/feat/x/sub/My%20Flow.zip'), 'https://raw.githubusercontent.com/o/r/feat/x/sub/My%20Flow.zip');
    const refused = (link) => assert.throws(() => U(link), (e) => e.key === 'linkNotZip', link);
    refused('');
    refused('not a link');
    refused('https://github.com/didierphmartin/workflows');
    refused('https://github.com/didierphmartin/workflows/tree/main');
    refused('https://github.com/didierphmartin/workflows/blob/main/README.md');
    refused('http://github.com/o/r/blob/main/a.zip');
    refused('https://example.com/o/r/blob/main/a.zip');
    refused('https://github.com/o/r/releases/download/v1/a.zip');
}

// the download: 404, HTTP errors, network errors, size cap and the zip check each give their message
(async () => {
    const F = ctx.window.WorkflowPackageUI.fetchPackageLink;
    const LINK = 'https://github.com/o/r/blob/main/a.zip';
    const res = (status, bytes, len) => ({ status, ok: status >= 200 && status < 300,
        headers: { get: (h) => (h === 'content-length' && len !== undefined ? String(len) : null) },
        arrayBuffer: async () => new Uint8Array(bytes).buffer });
    const zip = [0x50, 0x4b, 0x03, 0x04, 1, 2];
    let asked;
    const got = await F(LINK, async (u) => { asked = u; return res(200, zip); });
    assert.strictEqual(asked, 'https://raw.githubusercontent.com/o/r/main/a.zip');
    assert.deepStrictEqual(Array.from(got), zip);
    const fails = async (fn, key) => { await assert.rejects(F(LINK, fn), (e) => e.key === key, key); };
    await fails(async () => res(404, []), 'linkNotFound');
    await fails(async () => res(500, []), 'linkFailed');
    await fails(async () => { throw new Error('offline'); }, 'linkFailed');
    await fails(async () => res(200, zip, 60 * 1024 * 1024), 'linkTooBig');
    await fails(async () => res(200, [0x3c, 0x68, 0x74, 0x6d]), 'linkNotPackage');
    await assert.rejects(F(LINK, async () => { throw new Error('offline'); }), (e) => e.params.reason === 'offline');
    console.log('workflow-package-import link tests ok');
})().catch((e) => { console.error(e); process.exitCode = 1; });
