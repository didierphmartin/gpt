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

console.log('automations.test.js: all assertions passed');
