const assert = require('assert');
const WP = require('../workflow-package.js');

const ctx = { toolServers: new Map([['get_pto_balance', ['Workday']], ['poll_jobs', ['servicenow', 'servicenow-mock']]]),
              serverNameById: new Map([[7, 'vector_Qdrant']]) };
const nodes = [
  { id: '1', node_type: 'agent', config: { bound_skill: { dir_name: 'GEO/geo-compare' }, tools: ['get_pto_balance'], playbook_id: 3 } },
  { id: '2', node_type: 'code', config: { code_component_id: 12, mcp_servers: ['Outlook'] } },
  { id: '3', node_type: 'start', config: { start_option: 8 } },
  { id: '4', node_type: 'playbook', config: { playbook_source: 'input' } },
  { id: '5', node_type: 'vectorstore', config: { store: 'mcp:7' } },
];
const d = WP.collectDependencies(nodes, ctx);
assert.deepStrictEqual(d.skills, ['GEO/geo-compare']);
assert.deepStrictEqual(d.servers, ['Outlook', 'Workday', 'vector_Qdrant']);
assert.deepStrictEqual(d.components, [8, 12]);
assert.deepStrictEqual(d.playbooks, [3]);
assert.strictEqual(d.playbookAtRunTime, true);

// tool shared by two servers: both bundled, one warning
const d2 = WP.collectDependencies([{ id: '9', node_type: 'agent', config: { tools: ['poll_jobs'] } }], ctx);
assert.deepStrictEqual(d2.servers, ['servicenow', 'servicenow-mock']);
assert.strictEqual(d2.warnings.filter(w => w.kind === 'tool-ambiguous').length, 1);

// unknown tool: warning, nothing bundled
const d3 = WP.collectDependencies([{ id: '9', node_type: 'agent', config: { tools: ['nope'] } }], ctx);
assert.deepStrictEqual(d3.servers, []);
assert.strictEqual(d3.warnings[0].kind, 'tool-missing');

// a playbook node pointing at a stored playbook; duplicates collapse; non-mcp stores ignored
const d4 = WP.collectDependencies([
  { id: 'a', node_type: 'playbook', config: { playbook_id: 3 } },
  { id: 'b', node_type: 'agent', config: { playbook_id: 3 } },
  { id: 'c', node_type: 'loader', config: { store: 'local:x' } },
  { id: 'd', node_type: 'splitter', config: { store: 'mcp:99' } },
], ctx);
assert.deepStrictEqual(d4.playbooks, [3]);
assert.strictEqual(d4.playbookAtRunTime, false);
assert.deepStrictEqual(d4.servers, []);

// stripSecrets: connection secrets removed, input untouched
const orig = [{ id: '5', node_type: 'vectorstore', config: { connection: { url: 'u', api_key: 'K', collection: 'c' } } }];
const ss = WP.stripSecrets(orig);
assert.deepStrictEqual(ss.nodes[0].config.connection, { url: 'u', collection: 'c' });
assert.deepStrictEqual(ss.stripped, [{ node: '5', field: 'api_key' }]);
assert.strictEqual(orig[0].config.connection.api_key, 'K');
assert.ok(WP.SECRET_FIELD_RE.test('Password'));
assert.deepStrictEqual(WP.stripSecrets([{ id: '1', node_type: 'agent', config: {} }]).stripped, []);

console.log('workflow-package: ok');
