const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const src = fs.readFileSync(__dirname + '/../workflow-package-import.js', 'utf8');

// The result panel only: the module needs WorkflowPackageUI.esc at load and nothing else.
const ctx = { window: { WorkflowPackageUI: { esc: (x) => String(x) } }, console, setTimeout };
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
console.log('workflow-package-import: ok');
