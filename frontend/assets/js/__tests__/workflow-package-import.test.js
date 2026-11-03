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

// a server still starting reads "started" (not "running") and shows no log
assert.match(html('starting', ['booting']), /workflow\.package\.hostStarted/);
assert.doesNotMatch(html('starting', ['booting']), /hostRunning|booting/);
assert.match(html('running'), /workflow\.package\.hostRunning/);
assert.match(html('crashed', ['boom']), /hostInstallFailed[\s\S]*boom/);
console.log('workflow-package-import: ok');
