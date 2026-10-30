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

// selectServerFiles
const files = ['server.py','tests/t.py','.env','.env.example','.venv/x','a/__pycache__/b.pyc','data.sqlite-wal','README.md'];
assert.deepStrictEqual(WP.selectServerFiles(files, null), ['server.py', '.env.example', 'README.md']);
assert.deepStrictEqual(WP.selectServerFiles(files, { include: ['*.py', '.env'], exclude: [] }), ['server.py']);
assert.deepStrictEqual(WP.selectServerFiles(['a.py', 'sub/b.py', 'sub/c.txt'], { exclude: ['sub/b.py'] }), ['a.py', 'sub/c.txt']);
assert.deepStrictEqual(WP.selectServerFiles(['x/node_modules/y.js', 'x/logs/a.txt', 'app.log', 'docs/a.md', '.git/config', 'x/.hidden/f'], null), []);
assert.ok(WP.DEFAULT_EXCLUDES.includes('.env'));

// envFields / missingRequired / renderEnv
const ef = WP.envFields(null, '# Azure tenant\nAZURE_TENANT_ID=\nCLIENT_SECRET=abc\nPORT=8765\n');
assert.deepStrictEqual(ef.map((f) => f.name), ['AZURE_TENANT_ID', 'CLIENT_SECRET', 'PORT']);
assert.strictEqual(ef[0].label, 'Azure tenant');
assert.strictEqual(ef[1].secret, true);
assert.strictEqual(ef[2].default, '8765');
assert.strictEqual(ef[2].required, false);
const ef2 = WP.envFields(null, '# one\n# two\nA="q v"\n\n# stale\n\nB=1\nnot a pair\n');
assert.strictEqual(ef2[0].label, 'one two');
assert.strictEqual(ef2[0].default, 'q v');
assert.strictEqual(ef2[1].label, '');
assert.deepStrictEqual(WP.envFields({ env: [{ name: 'Z', required: true }] }, 'A=1\n'), [{ name: 'Z', label: '', required: true, secret: false, default: '' }]);
assert.deepStrictEqual(WP.missingRequired([{ name: 'A', required: true }, { name: 'B' }], { B: 'x' }), ['A']);
assert.deepStrictEqual(WP.missingRequired([{ name: 'A', required: true }], { A: 'v' }), []);
assert.strictEqual(WP.renderEnv({ A: 'x', B: 'a b' }), 'A=x\nB="a b"\n');
assert.strictEqual(WP.renderEnv({ C: 'say "hi"', D: 'a#b' }), 'C="say \\"hi\\""\nD="a#b"\n');

assert.strictEqual(WP.renderEnv({ K: 'x y\\' }), 'K="x y\\\\"\n');
assert.strictEqual(WP.renderEnv({ K: 'C:\\new dir' }), 'K="C:\\\\new dir"\n');
const inj = WP.renderEnv({ K: 'a"\nINJECT=1' });
assert.strictEqual(inj.split('\n').filter(Boolean).length, 1);
assert.ok(!inj.split('\n').some((l) => l.startsWith('INJECT=')));
assert.throws(() => WP.renderEnv({ 'BAD-KEY': '1' }), /invalid setting name: BAD-KEY/);
assert.deepStrictEqual(WP.selectServerFiles(['.secrets/.env.example', 'cfg/.env.example'], null), ['cfg/.env.example']);


// classify
assert.strictEqual(WP.classify('server', { name: 'Workday', url: 'u' }, [{ name: ' workday ', url: 'u' }]).status, 'present');
const sc = WP.classify('server', { name: 'Workday', url: 'u' }, [{ name: 'workday', url: 'v' }]);
assert.strictEqual(sc.status, 'clash');
assert.strictEqual(sc.match.url, 'v');
assert.deepStrictEqual(WP.classify('server', { name: 'Other', url: 'u' }, [{ name: 'workday', url: 'u' }]), { status: 'install' });
assert.strictEqual(WP.classify('playbook', { pkey: 'A', text: 't' }, [{ pkey: 'a', text: 't' }]).status, 'present');
assert.strictEqual(WP.classify('playbook', { pkey: 'A', text: 't' }, [{ pkey: 'a', text: 'x' }]).status, 'clash');
assert.strictEqual(WP.classify('playbook', { pkey: 'B', text: 't' }, [{ pkey: 'a', text: 't' }]).status, 'install');
assert.strictEqual(WP.classify('skill', { dir: 'Pdf', hash: 'h' }, [{ dir: 'pdf', hash: 'h' }]).status, 'present');
assert.strictEqual(WP.classify('skill', { dir: 'pdf', hash: 'h' }, [{ dir: 'pdf', hash: 'g' }]).status, 'clash');
assert.strictEqual(WP.classify('skill', { dir: 'new', hash: 'h' }, []).status, 'install');

// playbook md
const pb = { pkey: 'k1', title: 'Reset: password', text: 'line\n---\nmore: x\n---\nend\n' };
const md = WP.playbookToMd(pb);
assert.ok(md.startsWith('---\npkey: k1\ntitle: Reset: password\n---\nline'));
assert.deepStrictEqual(WP.mdToPlaybook(md), pb);
assert.deepStrictEqual(WP.mdToPlaybook(WP.playbookToMd({ pkey: 'a', title: 'b', text: '' })), { pkey: 'a', title: 'b', text: '' });

// relink
const maps = {
    serverNameByOldId: new Map([[7, 'Workday']]),
    serverIdByName: new Map([['Workday', 42]]),
    playbookIdByOldId: new Map([[3, 19]]),
};
const rnodes = [
    { node_type: 'vectorstore', config: { store: 'mcp:7', x: 1 } },
    { node_type: 'loader', config: { store: 'mcp:8' } },
    { node_type: 'splitter', config: { store: 'mcp:7' } },
    { node_type: 'playbook', config: { playbook_id: 3 } },
    { node_type: 'agent', config: { playbook_id: 3, name: 'a' } },
    { node_type: 'agent', config: { playbook_id: 99 } },
    { node_type: 'agent', config: { playbook_id: '3' } },
    { node_type: 'output', config: {} },
];
const frozen = JSON.stringify(rnodes);
const out = WP.relinkNodes(rnodes, maps);
assert.strictEqual(JSON.stringify(rnodes), frozen);
assert.strictEqual(out[0].config.store, 'mcp:42');
assert.strictEqual(out[0].config.x, 1);
assert.strictEqual(out[1].config.store, 'mcp:8');
assert.strictEqual(out[2].config.store, 'mcp:42');
assert.strictEqual(out[3].config.playbook_id, 19);
assert.strictEqual(out[4].config.playbook_id, 19);
assert.strictEqual(out[5].config.playbook_id, 99);
assert.strictEqual(out[6].config.playbook_id, 19);
assert.strictEqual(rnodes[6].config.playbook_id, '3');
assert.deepStrictEqual(out[7], rnodes[7]);

(async () => {
    const enc = (s) => new TextEncoder().encode(s);
    const h1 = await WP.filesHash({ 'a.txt': enc('1'), 'b/c.txt': enc('2') });
    const h2 = await WP.filesHash({ 'b/c.txt': enc('2'), 'a.txt': enc('1') });
    const h3 = await WP.filesHash({ 'a.txt': enc('1'), 'b/c.txt': enc('3') });
    assert.match(h1, /^[0-9a-f]{64}$/);
    assert.strictEqual(h1, h2);
    assert.notStrictEqual(h1, h3);
    console.log('workflow-package: ok');
})().catch((e) => { console.error(e); process.exit(1); });
