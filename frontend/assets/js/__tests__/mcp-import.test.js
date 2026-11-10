const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const src = fs.readFileSync(__dirname + '/../mcp-import.js', 'utf8');
const ctx = { window: {}, console, setTimeout };
vm.createContext(ctx);
vm.runInContext(src, ctx);
const { reviewState } = ctx.window.mcpImport;
const fetched = { folder: 'acme', fields: [{ name: 'KEY', required: true }, { name: 'OPT', required: false }] };
assert.deepStrictEqual(JSON.parse(JSON.stringify(reviewState(fetched, ['acme'], { KEY: 'x' }))), { canInstall: false, reason: 'installed' });
assert.strictEqual(reviewState(fetched, [], {}).reason, 'missing');
assert.strictEqual(reviewState(fetched, [], { KEY: '  ' }).canInstall, false);
assert.deepStrictEqual(JSON.parse(JSON.stringify(reviewState(fetched, ['other'], { KEY: 'x' }))), { canInstall: true, reason: null });
assert.strictEqual(reviewState({ folder: 'a' }, [], {}).canInstall, true);
const keys = ['button', 'title', 'linkLabel', 'linkHint', 'fetch', 'cancel', 'install', 'installed', 'missingRequired', 'installing', 'done', 'failed', 'runtimePhp', 'runtimePython', 'from'];
for (const l of ['en', 'es', 'fr']) {
    const j = JSON.parse(fs.readFileSync(__dirname + `/../../i18n/${l}.json`, 'utf8'));
    for (const k of keys) assert.ok(j.mcpLibrary.import && typeof j.mcpLibrary.import[k] === 'string', `${l} missing mcpLibrary.import.${k}`);
}
console.log('mcp-import: ok');
