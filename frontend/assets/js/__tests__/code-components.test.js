const assert = require('assert');
const CC = require('../code-components.js');

const row = { id: 4, name: 'Poll Inbox', description: '', code: 'def run(i, c):\n    return 1', exits: ['new_mail', 'no_mail'], mcp_servers: ['Outlook'], timeout_s: 20 };

// linked node config: the component's body, the node's own label, fresh arrays
const cfg = CC.linkedNodeConfig(row, 'Poll A');
assert.deepStrictEqual(cfg, { name: 'Poll A', code_component_id: 4, code: row.code, exits: ['new_mail', 'no_mail'], mcp_servers: ['Outlook'], timeout_s: 20, arg_decls: [], provides: [] });
cfg.exits.push('x');
assert.deepStrictEqual(row.exits, ['new_mail', 'no_mail']);
assert.strictEqual(CC.linkedNodeConfig(row).name, 'Poll Inbox');

// component body from a node form
assert.deepStrictEqual(CC.componentBody({ name: 'node label', code: 'c', exits: ['next'], mcp_servers: [], timeout_s: 30, disabled: true }, { name: ' Mine ', description: 'd' }),
    { name: 'Mine', description: 'd', code: 'c', exits: ['next'], mcp_servers: [], timeout_s: 30, args: [], provides: [] });

// name clash: trimmed, case-insensitive (MySQL utf8mb4_unicode_ci), never the row itself
CC.cache.put(row);
assert.strictEqual(CC.nameClash('  poll inbox ', null).id, 4);
assert.strictEqual(CC.nameClash('Poll Inbox', 4), null);
assert.strictEqual(CC.nameClash('Other', null), null);

// cache load
(async () => {
    const rows = await CC.cache.load({ list: async () => ({ data: [{ ...row, id: 7 }] }) });
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(CC.cache.get('7').id, 7);
    assert.strictEqual(CC.cache.get(4), null);
    await assert.rejects(CC.cache.load({ list: async () => { throw new Error('down'); } }));
    assert.strictEqual(CC.cache.loadFailed(), true);
    assert.ok(CC.CONTENT_KEYS.includes('arg_decls') && CC.CONTENT_KEYS.includes('provides'));
    const r1 = { id: 1, name: 'X', code: 'c', exits: ['next'], mcp_servers: [], timeout_s: 5 };
    const lc = CC.linkedNodeConfig({ ...r1, args: [{ name: 'f' }], provides: [{ name: 'p' }] });
    assert.deepStrictEqual([lc.arg_decls, lc.provides], [[{ name: 'f' }], [{ name: 'p' }]]);
    const lb = CC.linkedNodeConfig(r1);
    assert.deepStrictEqual([lb.arg_decls, lb.provides], [[], []]);
    const body = CC.componentBody({ ...lc, arg_decls: [{ name: 'f' }], provides: [] }, { name: 'X' });
    assert.deepStrictEqual([body.args, body.provides], [[{ name: 'f' }], []]);
    console.log('code-components tests passed');
})();
