const assert = require('assert');
const fs = require('fs');
const T = require('../mcp-protocol-test.js');

for (const lang of ['en', 'es', 'fr']) {
    const j = JSON.parse(fs.readFileSync(__dirname + '/../../i18n/' + lang + '.json', 'utf8'));
    const lib = j.mcpLibrary || {};
    assert.ok(lib.tabTest, lang + ': mcpLibrary.tabTest');
    for (const key of Object.keys(T.DEFAULT_LABELS)) {
        const v = lib.test && lib.test[key];
        assert.ok(typeof v === 'string' && v, lang + ': mcpLibrary.test.' + key);
        if (lang !== 'en') {
            // placeholders must survive translation
            const ph = s => (s.match(/\{\w+\}/g) || []).sort().join();
            assert.strictEqual(ph(v), ph(T.DEFAULT_LABELS[key]), lang + ': placeholders of ' + key);
        }
    }
}
console.log('mcp-protocol-test-i18n: ok');
