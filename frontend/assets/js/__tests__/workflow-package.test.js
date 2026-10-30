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

// buildManifest: registrations only, never a header value; needs_auth from an Authorization header
const man = WP.buildManifest({
    workflowName: 'Mail to PDF',
    deps: { warnings: [{ kind: 'tool-missing', node: '9', message: 'x' }] },
    servers: [
        { id: 4, name: 'Outlook', url: 'http://localhost:8765/mcp', description: 'mail', transport: 'http', is_mock: 0, user_id: 5,
          headers: { authorization: 'Bearer x' }, local: true, folder: 'outlook_mcp', hasManifest: true },
        { id: 9, name: 'Hosted', url: 'https://h.example/mcp', description: '', transport: 'http', is_mock: 1, user_id: null,
          headers: { Authorization: 'Bearer x', 'X-Other': 'y' } },
        { id: 10, name: 'Open', url: 'https://o.example/mcp', user_id: 5, headers: null },
    ],
    components: [{ id: 12, name: 'Make PDF', code: 'def run(): pass' }],
    playbooks: [{ id: 3, pkey: 'triage', title: 'Triage', text: 't' }],
    skills: ['GEO/geo-compare'],
    strippedSecrets: [{ node: '5', field: 'api_key' }],
});
assert.strictEqual(man.format, 'synergyai-workflow-package');
assert.strictEqual(man.version, 1);
assert.deepStrictEqual(man.workflow, { name: 'Mail to PDF' });
assert.ok(!JSON.stringify(man).includes('Bearer'));
assert.ok(!JSON.stringify(man).includes('X-Other'));
const srv = man.dependencies.filter((x) => x.kind === 'server');
assert.strictEqual(srv.length, 3);
assert.deepStrictEqual(srv[0], { kind: 'server', name: 'Outlook', url: 'http://localhost:8765/mcp', description: 'mail', transport: 'http',
    is_mock: false, needs_auth: true, old_id: 4, local: true, global: false, folder: 'mcps/outlook_mcp/', has_install_manifest: true });
assert.strictEqual(srv[1].needs_auth, true);
assert.strictEqual(srv[1].local, false);
assert.strictEqual(srv[1].is_mock, true);
assert.strictEqual(srv[1].global, true);
assert.strictEqual(srv[2].global, false);
assert.strictEqual(srv[2].needs_auth, false);
assert.ok(!('folder' in srv[1]));
assert.deepStrictEqual(man.dependencies.find((x) => x.kind === 'component'), { kind: 'component', name: 'Make PDF', old_id: 12, file: 'components/Make_PDF.json' });
assert.deepStrictEqual(man.dependencies.find((x) => x.kind === 'playbook'), { kind: 'playbook', name: 'Triage', pkey: 'triage', old_id: 3, file: 'playbooks/triage.md' });
assert.deepStrictEqual(man.dependencies.find((x) => x.kind === 'skill'), { kind: 'skill', name: 'GEO/geo-compare', folder: 'skills/GEO/geo-compare/' });
assert.deepStrictEqual(man.strippedSecrets, [{ node: '5', field: 'api_key' }]);
assert.deepStrictEqual(man.warnings, [{ kind: 'tool-missing', node: '9', message: 'x' }]);
// mcps/servers.json in the zip: the same registrations
assert.deepStrictEqual(WP.serverRegistration({ id: 1, name: 'A', url: 'u', headers: { AUTHORIZATION: 'k' } }),
    { name: 'A', url: 'u', description: '', transport: 'http', is_mock: false, needs_auth: true, old_id: 1, local: false, global: true });
assert.strictEqual(WP.safeFileName('a/b: c?'), 'a_b_c');

(async () => {
    const enc = (s) => new TextEncoder().encode(s);
    const h1 = await WP.filesHash({ 'a.txt': enc('1'), 'b/c.txt': enc('2') });
    const h2 = await WP.filesHash({ 'b/c.txt': enc('2'), 'a.txt': enc('1') });
    const h3 = await WP.filesHash({ 'a.txt': enc('1'), 'b/c.txt': enc('3') });
    assert.match(h1, /^[0-9a-f]{64}$/);
    assert.strictEqual(h1, h2);
    assert.notStrictEqual(h1, h3);

    // ---- Task 6: reader + review model
    const J = (o) => enc(JSON.stringify(o));
    assert.throws(() => WP.readPackage({ 'SKILL.md': enc('x') }), /not a workflow package/);
    assert.throws(() => WP.readPackage({ 'manifest.json': J({ format: 'other' }) }), /not a workflow package/);
    const comp = { id: 12, name: 'Make PDF', code: 'c', exits: ['ok'], mcp_servers: [], timeout_s: 30, args: [], provides: [], start_trigger: null };
    const pbText = WP.playbookToMd({ pkey: 'triage', title: 'Triage', text: 'body' });
    const entries = {
        'manifest.json': J({ format: 'synergyai-workflow-package', version: 1, workflow: { name: 'W' }, strippedSecrets: [{ node: '5', field: 'api_key' }],
            dependencies: [
                { kind: 'component', name: 'Make PDF', old_id: 12, file: 'components/Make_PDF.json' },
                { kind: 'playbook', name: 'Triage', pkey: 'triage', old_id: 3, file: 'playbooks/triage.md' },
            ] }),
        'workflow.json': J({ definition: { nodes: [] } }),
        'mcps/servers.json': J([
            { name: 'Outlook', url: 'http://localhost:8765/mcp', transport: 'http', needs_auth: true, global: false, local: true },
            { name: 'Hosted', url: 'https://x.example/mcp', transport: 'http', needs_auth: false, global: true, local: false },
        ]),
        'mcps/Outlook/.env.example': enc('# Tenant\nTENANT_ID=\n'),
        'mcps/Outlook/main.py': enc('x'),
        'skills/GEO/geo-compare/SKILL.md': enc('skill'),
        'components/Make_PDF.json': J(comp),
        'playbooks/triage.md': enc(pbText),
    };
    const pkg = WP.readPackage(entries);
    assert.strictEqual(pkg.servers.length, 2);
    assert.strictEqual(pkg.workflow.definition.nodes.length, 0);
    assert.deepStrictEqual(WP.readPackage({ 'manifest.json': J({ format: 'synergyai-workflow-package' }) }).servers, []);
    const skillHash = await WP.filesHash({ 'SKILL.md': enc('skill') });
    let rows = await WP.reviewRows(pkg, { servers: [], playbooks: [], skills: [], components: [] });
    const row = (k, n) => rows.find((r) => r.kind === k && r.name === n);
    const out = row('server', 'Outlook');
    assert.strictEqual(out.status, 'attention');
    assert.deepStrictEqual(out.reasons, ['localhost-url', 'needs-key']);
    assert.strictEqual(out.url, 'http://localhost:8765/mcp');
    assert.strictEqual(out.destination, 'mcps/Outlook');
    assert.strictEqual(row('server', 'Hosted').destination, null);
    assert.deepStrictEqual(row('server', 'Hosted').reasons, ['global-server']);
    assert.strictEqual(row('server', 'Hosted').status, 'install');
    assert.strictEqual(row('skill', 'GEO/geo-compare').destination, 'skills/GEO/geo-compare');
    assert.strictEqual(row('component', 'Make PDF').status, 'install');
    assert.strictEqual(row('secrets', 'workflow keys').status, 'attention');
    assert.deepStrictEqual(row('secrets', 'workflow keys').fields, [{ node: '5', field: 'api_key' }]);
    // settings-required for a required env field
    const pkg2 = WP.readPackage({ ...entries, 'mcps/Outlook/synergyai-mcp.json': J({ env: [{ name: 'TENANT_ID', required: true }] }) });
    rows = await WP.reviewRows(pkg2, { servers: [], playbooks: [], skills: [], components: [] });
    assert.ok(row('server', 'Outlook').reasons.includes('settings-required'));
    assert.strictEqual(row('server', 'Outlook').envFields[0].name, 'TENANT_ID');
    assert.strictEqual(WP.canConfirm(rows, {}), false);
    assert.strictEqual(WP.canConfirm(rows, { Outlook: { TENANT_ID: 't' } }), true);
    assert.strictEqual(WP.canConfirm(rows, { Outlook: { fillLater: true } }), true);
    // secrets row never blocks
    assert.strictEqual(WP.canConfirm([{ kind: 'secrets', status: 'attention', choice: null, reasons: ['workflow-keys'] }], {}), true);
    // present / clash
    rows = await WP.reviewRows(pkg, { servers: [{ name: 'hosted', url: 'https://x.example/mcp' }, { name: 'Outlook', url: 'http://other' }],
        playbooks: [{ pkey: 'triage', text: 'body' }], skills: [{ dir: 'GEO/geo-compare', hash: skillHash }], components: [comp] });
    assert.strictEqual(row('skill', 'GEO/geo-compare').status, 'present');
    assert.strictEqual(row('component', 'Make PDF').status, 'present');
    assert.strictEqual(row('playbook', 'triage').status, 'present');
    assert.strictEqual(row('server', 'Hosted').status, 'present');
    assert.strictEqual(row('server', 'Outlook').status, 'clash');
    assert.deepStrictEqual(row('server', 'Outlook').reasons, ['localhost-url', 'needs-key']);
    assert.strictEqual(WP.canConfirm(rows, {}), false);
    row('server', 'Outlook').choice = 'use-existing';
    assert.strictEqual(WP.canConfirm(rows, {}), true);
    row('server', 'Outlook').choice = null;
    row('server', 'Outlook').choice = 'skip';
    assert.strictEqual(WP.canConfirm(rows, {}), true);
    // component renamed
    rows = await WP.reviewRows(pkg, { servers: [], playbooks: [], skills: [], components: [{ ...comp, id: 99, code: 'different' }] });
    assert.deepStrictEqual(row('component', 'Make PDF').reasons, ['renamed']);
    assert.strictEqual(row('component', 'Make PDF').status, 'install');
    assert.strictEqual(WP.matchComponent(comp, [{ ...comp, id: 7, name: ' make pdf ' }]).id, 7);
    assert.strictEqual(WP.matchComponent(comp, [{ ...comp, id: 7, code: 'z' }]), null);

    // fix round 1: present stays present; unreadable component
    const pkg3 = WP.readPackage({ ...entries, 'mcps/Outlook/synergyai-mcp.json': J({ env: [{ name: 'TENANT_ID', required: true }] }) });
    rows = await WP.reviewRows(pkg3, { servers: [{ name: 'Outlook', url: 'http://localhost:8765/mcp' }], playbooks: [], skills: [], components: [] });
    // the incoming package server is local + needs_auth + localhost, with a required setting in its synergyai-mcp.json
    assert.strictEqual(pkg3.servers[0].local, true);
    assert.strictEqual(pkg3.servers[0].needs_auth, true);
    assert.ok(pkg3.files['mcps/Outlook/synergyai-mcp.json']);
    assert.strictEqual(row('server', 'Outlook').status, 'present');
    assert.ok(row('server', 'Outlook').reasons.includes('localhost-url') && row('server', 'Outlook').reasons.includes('needs-key'));
    assert.ok(!row('server', 'Outlook').reasons.includes('settings-required'));
    assert.ok(!row('server', 'Outlook').envFields);
    assert.strictEqual(WP.canConfirm(rows.filter((r) => r.kind === 'server'), {}), true);
    const pkg4 = WP.readPackage({ ...entries, 'components/Make_PDF.json': enc('{bad') });
    rows = await WP.reviewRows(pkg4, { servers: [], playbooks: [], skills: [], components: [] });
    assert.strictEqual(row('component', 'Make PDF').status, 'attention');
    assert.deepStrictEqual(row('component', 'Make PDF').reasons, ['unreadable']);
    assert.strictEqual(WP.canConfirm(rows, {}), false);
    row('component', 'Make PDF').choice = 'skip';
    assert.strictEqual(WP.canConfirm(rows, {}), true);
    console.log('workflow-package: ok');
})().catch((e) => { console.error(e); process.exit(1); });
