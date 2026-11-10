const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const src = fs.readFileSync(__dirname + '/../workflow-package-import.js', 'utf8');

// The result panel only: the module needs WorkflowPackageUI.esc at load and nothing else.
const ctx = { window: { WorkflowPackageUI: { esc: (x) => String(x) } }, console, setTimeout, btoa };
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
