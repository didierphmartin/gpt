// Workflow owner = the robot (spec 2026-10-29): list marks, the Owner select, the owner preview, the chat save refusal.
const assert = require('assert');
const RO = require('../robot-owner.js');

const t = (key, params = {}) => `${key}${Object.keys(params).length ? JSON.stringify(params) : ''}`;

(async () => {
    // list row marks: robot and lock on a locked robot workflow, robot alone on an idle one, nothing on a personal one
    const both = RO.rowMarks({ is_robot: true, locked: true }, t);
    assert.ok(both.includes('🤖') && both.includes('🔒'));
    const idle = RO.rowMarks({ is_robot: true, locked: false }, t);
    assert.ok(idle.includes('🤖') && !idle.includes('🔒'));
    assert.strictEqual(RO.rowMarks({ is_robot: false, locked: false }, t), '');
    assert.strictEqual(RO.rowMarks({}, t), '');

    // Owner select: hidden without can_use; "Robot" read-only on a robot workflow; "Me" editable otherwise
    assert.deepStrictEqual(RO.ownerView({ can_use: false }, { id: 3, is_robot: false }), { show: false });
    assert.deepStrictEqual(RO.ownerView(null, { id: 3 }), { show: false });
    assert.deepStrictEqual(RO.ownerView({ can_use: true }, { id: 3, is_robot: true }), { show: true, value: 'robot', disabled: true });
    assert.deepStrictEqual(RO.ownerView({ can_use: true }, { id: 3, is_robot: false }), { show: true, value: 'me', disabled: false });
    assert.deepStrictEqual(RO.ownerView({ can_use: true }, null), { show: true, value: 'me', disabled: false });

    // the preview as dialog lines: shared workflows, then missing servers; clashes as their own lines
    assert.deepStrictEqual(RO.previewLines({ shared_with: [{ id: 5, name: 'Other' }], needs_servers: ['Outlook'], clashes: [] }, t),
        ['workflow.owner.confirmShared{"name":"Other"}', 'workflow.owner.confirmServers{"name":"Outlook"}']);
    assert.deepStrictEqual(RO.previewLines({}, t), []);
    assert.deepStrictEqual(RO.clashLines({ clashes: [{ kind: 'component', name: 'Mail' }] }, t),
        ['workflow.owner.clash{"kind":"component","name":"Mail"}']);
    assert.deepStrictEqual(RO.clashLines({}, t), []);
    // a published robot copy of the playbook: unpublish it, not rename yours
    assert.deepStrictEqual(RO.clashLines({ clashes: [{ kind: 'playbook', name: 'filing', published: true }] }, t),
        ['workflow.owner.clashPublished{"name":"filing"}']);

    // link lists of a robot item: other users' workflows come as one {others} entry -- a line, and counted
    const used = [{ workflow_name: 'Mine', node_name: 'SP' }, { others: 2 }];
    assert.deepStrictEqual(used.map((u) => RO.linkLine(u, t, (x) => `${x.workflow_name} — ${x.node_name}`)),
        ['Mine — SP', 'workflow.owner.otherWorkflows{"count":2}']);
    assert.strictEqual(RO.linkCount(used), 3);
    assert.strictEqual(RO.linkCount([]), 0);

    // every new key is in en, es and fr
    for (const lang of ['en', 'es', 'fr']) {
        const dict = require(`../../i18n/${lang}.json`);
        for (const key of ['workflow.owner.clashPublished', 'workflow.owner.otherWorkflows', 'codeLibrary.linksDroppedOthers']) {
            assert.strictEqual(typeof key.split('.').reduce((o, k) => (o ? o[k] : undefined), dict), 'string', `${lang} ${key}`);
        }
    }

    // locked = robot-owned and running
    assert.ok(RO.isLocked({ is_robot: true, locked: true }));
    assert.ok(!RO.isLocked({ is_robot: true, locked: false }));
    assert.ok(!RO.isLocked({ is_robot: false, locked: true }));

    // Start's ▶ looks disabled on a locked workflow only where it is a browser run; ■ (the live view) stays usable
    assert.ok(RO.runDoorDisabled(true, { button: 'run' }));
    assert.ok(RO.runDoorDisabled(true, { button: 'deactivate', swarm: true }));
    assert.ok(RO.runDoorDisabled(true, { button: 'deactivate', ingestion: true }));
    assert.ok(RO.runDoorDisabled(true, { realtime: true }));
    assert.ok(!RO.runDoorDisabled(true, { button: 'deactivate' }));
    assert.ok(!RO.runDoorDisabled(false, { button: 'run' }));

    // chat save: a locked robot workflow is refused, and nothing stops it
    const calls = [];
    const api = (wf) => async (method, path) => {
        calls.push(`${method} ${path}`);
        return { ok: true, status: 200, json: { success: true, data: wf } };
    };
    const refused = await RO.chatSaveRefusal(api({ id: 75, name: 'VIP', is_robot: true, locked: true }), 75);
    assert.strictEqual(refused.success, false);
    assert.ok(refused.error.includes('VIP') && /unlock/i.test(refused.error));
    assert.deepStrictEqual(calls, ['GET /workflows/75']);
    assert.ok(!calls.some((c) => c.startsWith('DELETE')));
    calls.length = 0;
    assert.strictEqual(await RO.chatSaveRefusal(api({ id: 75, name: 'VIP', is_robot: true, locked: false }), 75), null);
    assert.strictEqual(await RO.chatSaveRefusal(api({ id: 4, name: 'Mine', is_robot: false, locked: false }), 4), null);
    // a failed read is not a refusal: the PUT itself is guarded by the server's 423
    assert.strictEqual(await RO.chatSaveRefusal(async () => ({ ok: false, status: 404, json: {} }), 9), null);

    console.log('robot-owner.test.js: all passed');
})().catch((e) => { console.error(e); process.exit(1); });
