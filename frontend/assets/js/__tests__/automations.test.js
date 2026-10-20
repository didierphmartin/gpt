const assert = require('assert');
const AV = require('../automations-view.js');

// deployFileList: the connector's deploy allowlist (DeployToolset::allowedPath), nothing else.
assert.deepStrictEqual(AV.deployFileList([
    'package.json', 'now.config.json', 'src/fluent/index.now.ts', 'src/fluent/generated/keys.ts',
    'src/fluent/flows/okta-reset.now.ts', 'README.md', 'build-install.sh', 'FLOWS.md', 'flow-specs/okta.json',
    'src/server/script.js', 'src/fluent/../evil.ts', '/abs/src/fluent/a.ts', 'src/fluent/.hidden.ts',
    'node_modules/x/package.json', 'src/fluent/a.js', 'src/fluent/a.ts.bak', 'src\\fluent\\a.ts', 'package.json',
    42, null,
]), ['package.json', 'now.config.json', 'src/fluent/index.now.ts', 'src/fluent/generated/keys.ts',
    'src/fluent/flows/okta-reset.now.ts']);
assert.deepStrictEqual(AV.deployFileList([]), []);
assert.deepStrictEqual(AV.deployFileList(null), []);

// driftSummary: one clause per instance, by status.
const inst = (o) => ({ mcp_server_id: 3, installed_version: null, status: 'not_installed', environment: null, detail: '', ...o });
assert.strictEqual(AV.driftSummary([]), 'not checked yet');
assert.strictEqual(AV.driftSummary(null), 'not checked yet');
assert.strictEqual(AV.driftSummary([inst({ status: 'in_sync', installed_version: 4, environment: 'dev', server_name: 'ServiceNow PDI' })]),
    'ServiceNow PDI (dev): in sync, v4');
assert.strictEqual(AV.driftSummary([inst({ status: 'out_of_sync', installed_version: 3, environment: 'test',
    detail: 'version 3 in ServiceNow, spec is 4' })]),
    'server 3 (test): out of sync — version 3 in ServiceNow, spec is 4');
assert.strictEqual(AV.driftSummary([inst({ status: 'out_of_sync', detail: '' })]), 'server 3: out of sync');
assert.strictEqual(AV.driftSummary([inst({ status: 'not_installed' })]), 'server 3: not installed');
assert.strictEqual(AV.driftSummary([inst({ status: 'weird' })]), 'server 3: weird');
assert.strictEqual(AV.driftSummary([inst({ status: 'in_sync', installed_version: 2 }), inst({ mcp_server_id: 5 })]),
    'server 3: in sync, v2; server 5: not installed');

// clientToolNames: the browser-side save tools each skill gets.
assert.deepStrictEqual(AV.clientToolNames('playbook-author'), ['save_playbook_agent']);
assert.deepStrictEqual(AV.clientToolNames('workflow-compile'), ['save_workflow']);
assert.deepStrictEqual(AV.clientToolNames('servicenow-automation-author'),
    ['save_playbook_agent', 'save_workflow', 'save_automation', 'install_automation']);
assert.deepStrictEqual(AV.clientToolNames('servicenow-flow-author'), []);
assert.deepStrictEqual(AV.clientToolNames(undefined), []);

// saveAutomationPlan: a spec alone creates or bumps (POST); with ids it links (PUT, the spec replaced without a bump),
// so the skill's step 5 never bumps the version a second time.
assert.deepStrictEqual(AV.saveAutomationPlan({ key: 'okta-reset', title: 'Okta reset', spec: { name: 'okta-reset' } }),
    { method: 'POST', body: { key: 'okta-reset', title: 'Okta reset', spec: { name: 'okta-reset' } } });
assert.deepStrictEqual(AV.saveAutomationPlan({ key: 'okta-reset', title: 'Okta reset', spec: { name: 'okta-reset' }, playbook_id: 7, workflow_id: 9 }),
    { method: 'PUT', body: { spec: { name: 'okta-reset' }, playbook_id: 7, workflow_id: 9 } });
assert.deepStrictEqual(AV.saveAutomationPlan({ key: 'okta-reset', title: 'T', workflow_id: '9' }),
    { method: 'PUT', body: { workflow_id: 9 } });
// The spec may arrive as a JSON string.
assert.deepStrictEqual(AV.saveAutomationPlan({ key: 'k1', title: 'T', spec: '{"name":"k1"}' }).body.spec, { name: 'k1' });
assert.ok(AV.saveAutomationPlan({ key: 'k1', title: 'T' }).error);
assert.ok(AV.saveAutomationPlan({ key: 'Bad Key', title: 'T', spec: { a: 1 } }).error);
assert.ok(AV.saveAutomationPlan({ key: 'k1', title: '', spec: { a: 1 } }).error);
assert.ok(AV.saveAutomationPlan({ key: 'k1', title: 'T', spec: 'not json' }).error);
assert.ok(AV.saveAutomationPlan({ key: 'k1', title: 'T', playbook_id: -1 }).error);

// outputsPath: save_workflow reads only a file under /outputs/.
assert.strictEqual(AV.outputsPath('/outputs/okta-reset.workflow.json'), '/outputs/okta-reset.workflow.json');
assert.strictEqual(AV.outputsPath('okta-reset.workflow.json'), '/outputs/okta-reset.workflow.json');
assert.strictEqual(AV.outputsPath('/outputs/../etc/passwd'), null);
assert.strictEqual(AV.outputsPath('/scratch/x.json'), null);
assert.strictEqual(AV.outputsPath(''), null);

// The manual install line when the connector refuses (prod or unset SN_ENVIRONMENT).
assert.strictEqual(AV.manualInstallMessage('x_1234567_synergy'),
    'install manually: sh build-install.sh in ~/Documents/synergyAI/outputs/servicenow/x_1234567_synergy/');

// placeholdersIn: the PLACEHOLDER:<name> values still in the app's files (sorted, unique).
assert.deepStrictEqual(AV.placeholdersIn({
    'package.json': '{}',
    'src/fluent/flows/okta-reset.now.ts': "catalogs: ['PLACEHOLDER:service_catalog'], group: 'PLACEHOLDER:synergyai_group', x: 'PLACEHOLDER:synergyai_group'",
    'src/fluent/items/okta-reset.now.ts': "categories: ['PLACEHOLDER:synergyai_category']",
}), ['service_catalog', 'synergyai_category', 'synergyai_group']);
assert.deepStrictEqual(AV.placeholdersIn({ 'src/fluent/a.now.ts': "group: 'abc123'" }), []);
assert.deepStrictEqual(AV.placeholdersIn({ 'src/fluent/a.now.ts': "group: 'PLACEHOLDER'" }), ['PLACEHOLDER']);

// playbookKeyPlan (ruling R11): the playbook key IS the automation key. On a pkey collision, the existing playbook
// is updated in place when it is unmanaged or this automation's; another automation's playbook is refused.
assert.deepStrictEqual(AV.playbookKeyPlan({ id: 4, pkey: 'okta-reset', automation_id: null }, 9), { action: 'update', playbook_id: 4 });
assert.deepStrictEqual(AV.playbookKeyPlan({ id: 4, pkey: 'okta-reset' }, 9), { action: 'update', playbook_id: 4 });
assert.deepStrictEqual(AV.playbookKeyPlan({ id: 4, pkey: 'okta-reset', automation_id: 9 }, 9), { action: 'update', playbook_id: 4 });
assert.deepStrictEqual(AV.playbookKeyPlan({ id: 4, pkey: 'okta-reset', automation_id: '9' }, 9), { action: 'update', playbook_id: 4 });
assert.deepStrictEqual(AV.playbookKeyPlan({ id: 4, pkey: 'okta-reset', automation_id: 7 }, 9), { action: 'refuse', automation_id: 7 });
assert.deepStrictEqual(AV.playbookKeyPlan(null, 9), { action: 'refuse', automation_id: null });
assert.strictEqual(AV.keyTakenMessage('okta-reset', 'Okta MFA reset'),
    'key "okta-reset" taken by automation Okta MFA reset');

// startOptionOf: the Start option's component id in a saved workflow's graph (config as an object or JSON text).
assert.strictEqual(AV.startOptionOf({ nodes: [{ id: 1, node_type: 'agent', config: {} },
    { id: 2, node_type: 'start', config: { type: 'start', start_option: 12, start_args: { tag: 'okta-reset' } } },
    { id: 1000000002, node_type: 'code', config: { code_component_id: 12 } }] }), 12);
assert.strictEqual(AV.startOptionOf({ nodes: [{ id: 2, node_type: 'start', config: '{"type":"start","start_option":"7"}' }] }), 7);
assert.strictEqual(AV.startOptionOf({ nodes: [{ id: 2, node_type: 'start', config: { type: 'start' } }] }), null);
// the shape GET /workflows/{id} returns (getGraphForFrontend: `type`, config an object)
assert.strictEqual(AV.startOptionOf({ nodes: [{ id: '4', type: 'agent', config: { type: 'agent' } }, { id: '5', type: 'start', config: { type: 'start', start_option: 3 } }] }), 3);
assert.strictEqual(AV.startOptionOf(null), null);

// startSchedulePlan (ruling R13): the event schedule that lets ▶ start a saved workflow on its Start option. The
// current row (pending or paused, as the editor reads it) is updated; none -> a new one.
const now = '2026-10-20T09:30';
assert.deepStrictEqual(AV.startSchedulePlan([], 5, 12, now), { method: 'POST', path: '/schedules',
    body: { workflow_id: 5, trigger_component_id: 12, repeat_type: 'event', scheduled_time: now, input_prompt: '' } });
assert.deepStrictEqual(AV.startSchedulePlan([{ id: 3, status: 'completed' }, { id: 8, status: 'pending', repeat_type: 'daily', input_prompt: 'go' }], 5, 12, now),
    { method: 'PUT', path: '/schedules/8',
        body: { workflow_id: 5, trigger_component_id: 12, repeat_type: 'event', scheduled_time: now, input_prompt: 'go' } });
assert.strictEqual(AV.startSchedulePlan([{ id: 9, status: 'paused' }], 5, 12, now).path, '/schedules/9');

(async () => {
    // installAutomation refuses an app that still holds placeholders, before anything is sent (ruling R12).
    const files = {
        'package.json': '{}',
        'src/fluent/flows/okta-reset.now.ts': "group: 'PLACEHOLDER:synergyai_group', cat: 'PLACEHOLDER:service_catalog'",
    };
    global.window = { pyodideRunner: {
        listOutputFiles: async () => Object.keys(files),
        readOutputFile: async (p) => files[p.replace('/outputs/servicenow/x_1_synergy/', '')],
    } };
    let sent = 0;
    const api = { install: async () => { sent++; return {}; }, check: async () => ({}) };
    const r = await AV.installAutomation(api, 3, 5, 'x_1_synergy');
    assert.strictEqual(sent, 0);
    assert.strictEqual(r.success, false);
    assert.strictEqual(r.installed, false);
    assert.deepStrictEqual(r.placeholders, ['service_catalog', 'synergyai_group']);
    assert.ok(/service_catalog, synergyai_group/.test(r.error), r.error);
    assert.ok(/create\.py/.test(r.hint), r.hint);

    // Filled: the install goes through.
    files['src/fluent/flows/okta-reset.now.ts'] = "group: 'abc', cat: 'def'";
    const ok = await AV.installAutomation(api, 3, 5, 'x_1_synergy');
    assert.strictEqual(sent, 1);
    assert.strictEqual(ok.installed, true);
    delete global.window;
    console.log('automations.test.js: all assertions passed');
})().catch((e) => { console.error(e); process.exit(1); });
