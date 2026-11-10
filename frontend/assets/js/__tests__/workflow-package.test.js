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

// unknown MCP tool: warning, nothing bundled; a built-in (unprefixed) tool needs no server
const d3 = WP.collectDependencies([{ id: '9', node_type: 'agent', config: { tools: ['mcp_nope', 'web_search'] } }], ctx);
assert.deepStrictEqual(d3.servers, []);
assert.strictEqual(d3.warnings.length, 1);
assert.strictEqual(d3.warnings[0].kind, 'tool-missing');

// agents store MCP tools with the mcp_ prefix
const d3b = WP.collectDependencies([{ id: '9', node_type: 'agent', config: { tools: ['mcp_get_pto_balance'] } }], ctx);
assert.deepStrictEqual(d3b.servers, ['Workday']);
assert.deepStrictEqual(d3b.warnings, []);

// a playbook node's validated servers are bundled
const d3c = WP.collectDependencies([{ id: '9', node_type: 'playbook', config: { mcp_servers: ['ServiceNow'] } }], ctx);
assert.deepStrictEqual(d3c.servers, ['ServiceNow']);

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
// dsn / connection strings hold the password inside the value (pgvector, Azure)
const conn2 = WP.stripSecrets([{ id: '6', node_type: 'vectorstore', config: { connection: {
    dsn: 'postgresql://u:pw@h/db', connection_string: 'DefaultEndpointsProtocol=https;AccountKey=abc', conn_str: 'x', auth_header: 'y', bearer: 'z', private_pem: 'p', host: 'h' } } }]);
assert.deepStrictEqual(conn2.nodes[0].config.connection, { host: 'h' });
assert.deepStrictEqual(conn2.stripped.map((x) => x.field), ['dsn', 'connection_string', 'conn_str', 'auth_header', 'bearer', 'private_pem']);
for (const f of ['DSN', 'Connection_String', 'connstr', 'PRIVATE_KEY']) assert.ok(WP.SECRET_FIELD_RE.test(f), f);
assert.ok(WP.SECRET_FIELD_RE.test('EVENTHUB_CONNECTION'));

// selectServerFiles
const files = ['server.py','tests/t.py','.env','.env.example','.venv/x','a/__pycache__/b.pyc','data.sqlite-wal','README.md'];
assert.deepStrictEqual(WP.selectServerFiles(files, null), ['server.py', '.env.example', 'README.md']);
assert.deepStrictEqual(WP.selectServerFiles(files, { include: ['*.py', '.env'], exclude: [] }), ['server.py']);
assert.deepStrictEqual(WP.selectServerFiles(['a.py', 'sub/b.py', 'sub/c.txt'], { exclude: ['sub/b.py'] }), ['a.py', 'sub/c.txt']);
assert.deepStrictEqual(WP.selectServerFiles(['x/node_modules/y.js', 'x/logs/a.txt', 'app.log', 'docs/a.md', '.git/config', 'x/.hidden/f'], null), []);
assert.ok(WP.DEFAULT_EXCLUDES.includes('.env'));
// generic secret files never ship
assert.deepStrictEqual(WP.selectServerFiles(['server.py', 'cert.pem', 'tls.key', 'id.p12', 'a/b.pfx', 'credentials.json', 'credentials-prod.json',
    'token.json', 'token_cache.json', 'client_secret.txt', 'my-secrets.yaml', 'keys.py', 'config.json'], null), ['server.py', 'keys.py', 'config.json']);

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

// parseEnv: KEY=value lines; quoted values unquoted; round-trips renderEnv
assert.deepStrictEqual(WP.parseEnv('A=1\n# comment\n\nexport B = two \nC="x y"\nD=\'s q\'\nnot a pair\nE=\n'),
    { A: '1', B: 'two', C: 'x y', D: 's q', E: '' });
assert.deepStrictEqual(WP.parseEnv('A=1\r\nB="q"\r\n'), { A: '1', B: 'q' });
assert.deepStrictEqual(WP.parseEnv('A=v # note\nB="v # kept"\n'), { A: 'v', B: 'v # kept' });
assert.deepStrictEqual(WP.parseEnv(''), {});
assert.deepStrictEqual(WP.parseEnv(undefined), {});
const rt = { PLAIN: 'abc', SPACES: 'a b  c', QUOTES: 'say "hi" and \'yo\'', BACK: 'C:\\new dir\\', NL: 'line1\nline2\r\nline3', HASH: 'a#b', EMPTY: '', MIX: '\\"\n\\n' };
const back = WP.parseEnv(WP.renderEnv(rt));
assert.deepStrictEqual(back, { ...rt, NL: 'line1\nline2\nline3' });


// mergeEnv: comments and undeclared keys kept, declared keys replaced in place, new ones appended, renderEnv escaping
const before = '# Outlook settings\nTENANT_ID=old\nSHAREPOINT_LIBRARY=Docs\n\n# python\nexport OUTLOOK_PYTHON=/usr/bin/python3\nPORT=8765\n';
assert.strictEqual(WP.mergeEnv(before, { TENANT_ID: 'new id', PORT: '9000', CLIENT_SECRET: 's"x' }),
    '# Outlook settings\nTENANT_ID="new id"\nSHAREPOINT_LIBRARY=Docs\n\n# python\nexport OUTLOOK_PYTHON=/usr/bin/python3\nPORT=9000\nCLIENT_SECRET="s\\"x"\n');
assert.deepStrictEqual(WP.parseEnv(WP.mergeEnv(before, { TENANT_ID: 'a\nINJECT=1' })), { TENANT_ID: 'a\nINJECT=1', SHAREPOINT_LIBRARY: 'Docs', OUTLOOK_PYTHON: '/usr/bin/python3', PORT: '8765' });
assert.strictEqual(WP.mergeEnv('', { A: '1' }), WP.renderEnv({ A: '1' }));
assert.strictEqual(WP.mergeEnv(null, {}), '\n');
assert.strictEqual(WP.mergeEnv('A=1\r\nB=2', { B: '3' }), 'A=1\nB=3\n');
assert.strictEqual(WP.mergeEnv('A=1\n', { constructor: 'c' }), 'A=1\nconstructor=c\n');
assert.throws(() => WP.mergeEnv('A=1\n', { 'BAD-KEY': 'x' }), /invalid setting name/);

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
assert.deepStrictEqual(man.dependencies.find((x) => x.kind === 'skill'), { kind: 'skill', name: 'GEO/geo-compare', zip: 'skills/GEO/geo-compare.skill.zip' });
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
                { kind: 'skill', name: 'GEO/geo-compare', folder: 'skills/GEO/geo-compare/' },
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

    // ---- Task 8: installer
    {
        const srvMan = { install: 'python3 -m venv .venv', start: '.venv/bin/python server.py', env: [{ name: 'TENANT_ID', required: true }, { name: 'PORT', default: '8765' }] };
        const comp8 = { ...comp, name: 'Make PDF' };
        const ientries = {
            'manifest.json': J({ format: 'synergyai-workflow-package', version: 1, workflow: { name: 'W' }, strippedSecrets: [{ node: '5', field: 'api_key' }],
                dependencies: [
                    { kind: 'skill', name: 'pdf', folder: 'skills/pdf/' },
                    { kind: 'server', name: 'Outlook', old_id: 4, local: true, folder: 'mcps/outlook_mcp/' },
                    { kind: 'server', name: 'Hosted', old_id: 9 },
                    { kind: 'component', name: 'Make PDF', old_id: 12, file: 'components/Make_PDF.json' },
                    { kind: 'playbook', name: 'Triage', pkey: 'triage', old_id: 3, file: 'playbooks/triage.md' },
                ] }),
            'workflow.json': J({ definition: { nodes: [
                { id: '1', node_type: 'loader', config: { store: 'mcp:4' } },
                { id: '2', node_type: 'vectorstore', config: { store: 'mcp:9' } },
                { id: '3', node_type: 'playbook', config: { playbook_id: 3 } },
                { id: '4', node_type: 'code', config: { code_component_id: 12 } },
                { id: '5', node_type: 'vectorstore', config: { store: 'mcp:9', connection: { url: 'u' } } },
            ] }, code_components: [comp8] }),
            'mcps/servers.json': J([
                { name: 'Outlook', url: 'http://localhost:8765/mcp', description: 'mail', transport: 'http', is_mock: false, needs_auth: true, global: false, local: true, old_id: 4 },
                { name: 'Hosted', url: 'https://x.example/mcp', description: '', transport: 'http', is_mock: false, needs_auth: false, global: true, local: false, old_id: 9 },
            ]),
            'mcps/outlook_mcp/server.py': enc('print(1)'),
            'mcps/outlook_mcp/synergyai-mcp.json': J(srvMan),
            'mcps/outlook_mcp/.env': enc('LEAK=1'),   // never shipped, but guarded anyway
            'skills/pdf/SKILL.md': enc('skill'),
            'skills/pdf/scripts/a.py': enc('a'),
            'components/Make_PDF.json': J(comp8),
            'playbooks/triage.md': enc(WP.playbookToMd({ pkey: 'triage', title: 'Triage', text: 'body' })),
        };
        const ipkg = WP.readPackage(ientries);
        const memIo = (opts = {}) => {
            const fs = { ...(opts.fs || {}) };
            const calls = [];
            let nextId = 100;
            return { fs, calls,
                exists: async (p) => Object.keys(fs).some((k) => k === p || k.startsWith(p + '/')),
                ensureDir: async (p) => { calls.push(['ensureDir', p]); },
                writeFile: async (p, b) => { calls.push(['writeFile', p]); assert.ok(b instanceof Uint8Array); fs[p] = new TextDecoder().decode(b); },
                importSkill: async (read, o) => { calls.push(['importSkill', read.dir, read, o]); if (opts.skillClash) throw Object.assign(new Error('different'), { code: 'clash' }); return { status: 'installed' }; },
                readJson: async (p) => (fs[p] === undefined ? undefined : JSON.parse(fs[p])),
                writeJson: async (p, o) => { calls.push(['writeJson', p]); fs[p] = JSON.stringify(o); },
                addServer: async (reg) => { calls.push(['addServer', reg]); if (opts.failServer === reg.name) throw new Error('boom'); return { id: nextId++ }; },
                createPlaybook: async (pb) => { calls.push(['createPlaybook', pb]); return { id: 55 }; },
                installServer: async (folder, body) => { calls.push(['installServer', folder, body]); if (opts.failInstall === folder) throw new Error('no good'); return { state: 'running' }; },
                importComponents: async (bundle, nodes) => { calls.push(['importComponents', bundle]);
                    const ids = new Set(bundle.map((c) => Number(c.id)));
                    return nodes.map((n) => (n.node_type === 'code' && ids.has(Number(n.config.code_component_id)) ? { ...n, config: { ...n.config, code_component_id: 77 } } : n)); },
            };
        };
        const ihave = { servers: [{ id: 31, name: 'Hosted', url: 'https://x.example/mcp' }], playbooks: [], skills: [], components: [] };
        let irows = await WP.reviewRows(ipkg, ihave);
        const irow = (k, n) => irows.find((r) => r.kind === k && r.name === n);
        assert.strictEqual(irow('server', 'Outlook').destination, 'mcps/outlook_mcp');
        assert.strictEqual(irow('server', 'Hosted').status, 'present');
        const ivalues = { Outlook: { TENANT_ID: 't 1', PORT: '9000', url: 'http://localhost:9000/mcp', authorization: 'Bearer k' },
            [WP.WORKFLOW_KEYS]: { '5.api_key': 'SECRET', '2.api_key': '' } };
        let io = memIo({ fs: { 'mcps/servers.json': JSON.stringify({ Old: 'old_mcp' }) } });
        let res = await WP.installPackage(irows, ipkg, ivalues, io, ihave);
        const writes = io.calls.filter((c) => c[0] === 'writeFile').map((c) => c[1]);
        assert.deepStrictEqual(io.calls.slice(0, 4).map((c) => c[1]), ['skills', 'mcps', 'components', 'playbooks']);
        const sk = io.calls.find((c) => c[0] === 'importSkill');
        assert.ok(sk && sk[1] === 'pdf' && sk[3].visibility === 'private');
        assert.deepStrictEqual(Object.keys(sk[2].files).sort(), ['SKILL.md', 'scripts/a.py']);
        assert.ok(!writes.some((p) => p.startsWith('skills/')), 'skills go through importSkill, not writeFile');
        for (const p of ['mcps/outlook_mcp/server.py', 'mcps/outlook_mcp/synergyai-mcp.json',
            'mcps/outlook_mcp/.env', 'playbooks/triage.md', 'components/Make_PDF.json']) assert.ok(writes.includes(p), p);
        assert.strictEqual(io.fs['mcps/outlook_mcp/.env'], WP.renderEnv({ TENANT_ID: 't 1', PORT: '9000' }));
        assert.ok(!io.fs['mcps/outlook_mcp/.env'].includes('LEAK'));
        assert.strictEqual(writes.filter((p) => p === 'mcps/outlook_mcp/.env').length, 1);
        assert.deepStrictEqual(JSON.parse(io.fs['mcps/servers.json']), { Old: 'old_mcp', Outlook: 'outlook_mcp' });
        const adds = io.calls.filter((c) => c[0] === 'addServer');
        assert.strictEqual(adds.length, 1);
        assert.deepStrictEqual(adds[0][1], { name: 'Outlook', url: 'http://localhost:9000/mcp', description: 'mail', transport: 'http', is_mock: false,
            headers: { Authorization: 'Bearer k' } });
        assert.deepStrictEqual(io.calls.find((c) => c[0] === 'createPlaybook')[1], { pkey: 'triage', title: 'Triage', text: 'body' });
        assert.deepStrictEqual(io.calls.find((c) => c[0] === 'importComponents')[1], [comp8]);
        // order: skills -> server files -> servers.json -> register -> playbooks -> components
        const at = (pred) => io.calls.findIndex(pred);
        assert.ok(at((c) => c[0] === 'importSkill') < at((c) => c[1] === 'mcps/outlook_mcp/server.py'));
        assert.ok(at((c) => c[1] === 'mcps/outlook_mcp/.env') < at((c) => c[0] === 'writeJson'));
        assert.ok(at((c) => c[0] === 'writeJson') < at((c) => c[0] === 'addServer'));
        assert.ok(at((c) => c[0] === 'addServer') < at((c) => c[0] === 'createPlaybook'));
        assert.ok(at((c) => c[0] === 'createPlaybook') < at((c) => c[0] === 'importComponents'));
        assert.deepStrictEqual(res.commands, [{ server: 'Outlook', install: srvMan.install, start: srvMan.start }]);
        const rn = (id) => res.nodes.find((n) => n.id === id);
        assert.strictEqual(rn('1').config.store, 'mcp:100');       // installed server id
        assert.strictEqual(rn('2').config.store, 'mcp:31');        // present server: existing id
        assert.strictEqual(rn('3').config.playbook_id, 55);
        assert.strictEqual(rn('4').config.code_component_id, 77);
        assert.deepStrictEqual(rn('5').config.connection, { url: 'u', api_key: 'SECRET' });
        assert.strictEqual(rn('2').config.connection, undefined);  // empty key skipped
        assert.deepStrictEqual(res.installed.map((x) => [x.kind, x.name, x.destination]), [
            ['skill', 'pdf', 'skills/pdf'], ['server-files', 'Outlook', 'mcps/outlook_mcp'], ['server', 'Outlook', 'mcps/outlook_mcp'], ['playbook', 'triage', 'playbooks/triage.md'],
            ['component', 'Make PDF', 'components/Make_PDF.json']]);
        assert.strictEqual(JSON.parse(ientries['workflow.json'] && new TextDecoder().decode(ientries['workflow.json'])).definition.nodes[4].config.connection.api_key, undefined);

        // skip rows write nothing; use-existing server id flows into the relink; fillLater writes no settings file
        const have2 = { servers: [{ id: 31, name: 'Hosted', url: 'https://x.example/mcp' }, { id: 40, name: 'Outlook', url: 'http://other' }],
            playbooks: [], skills: [], components: [] };
        irows = await WP.reviewRows(ipkg, have2);
        assert.strictEqual(irow('server', 'Outlook').status, 'clash');
        irow('server', 'Outlook').choice = 'use-existing';
        irow('skill', 'pdf').choice = 'skip';
        irow('playbook', 'triage').choice = 'skip';
        irow('component', 'Make PDF').choice = 'skip';
        io = memIo();
        res = await WP.installPackage(irows, ipkg, {}, io, have2);
        assert.deepStrictEqual(io.calls.filter((c) => c[0] !== 'ensureDir' && c[0] !== 'importComponents'), []);
        assert.deepStrictEqual(io.calls.find((c) => c[0] === 'importComponents')[1], []);
        assert.strictEqual(res.nodes.find((n) => n.id === '1').config.store, 'mcp:40');
        // a skipped playbook: its exporter id would point at an unrelated row here -> cleared and flagged
        assert.strictEqual(res.nodes.find((n) => n.id === '3').config.playbook_id, null);
        assert.strictEqual(res.nodes.find((n) => n.id === '3').config.playbook_missing, true);
        // a skipped component: the link is cleared and flagged before the import
        assert.strictEqual(res.nodes.find((n) => n.id === '4').config.code_component_id, null);
        assert.strictEqual(res.nodes.find((n) => n.id === '4').config.code_component_missing, true);
        assert.deepStrictEqual(res.installed, []);
        assert.deepStrictEqual(res.commands, []);

        irows = await WP.reviewRows(ipkg, ihave);
        io = memIo();
        res = await WP.installPackage(irows, ipkg, { Outlook: { fillLater: true } }, io, ihave);
        assert.ok(io.fs['mcps/outlook_mcp/server.py'] !== undefined);
        assert.strictEqual(io.fs['mcps/outlook_mcp/.env'], undefined);
        assert.deepStrictEqual(io.calls.find((c) => c[0] === 'addServer')[1].headers, {});
        assert.strictEqual(io.calls.find((c) => c[0] === 'addServer')[1].url, 'http://localhost:8765/mcp');
        assert.deepStrictEqual(JSON.parse(io.fs['mcps/servers.json']), { Outlook: 'outlook_mcp' });

        // a failing registration stops the install, naming the step, with what was installed so far
        io = memIo({ failServer: 'Outlook' });
        let err = null;
        try { await WP.installPackage(irows, ipkg, { Outlook: { fillLater: true } }, io, ihave); } catch (e) { err = e; }
        assert.ok(err instanceof Error);
        assert.strictEqual(err.message, 'install failed at "register server Outlook": boom');
        assert.deepStrictEqual(err.installed.map((x) => [x.kind, x.name]), [['skill', 'pdf'], ['server-files', 'Outlook']]);
        assert.ok(!io.calls.some((c) => c[0] === 'createPlaybook'));

        // fix round 1: refuses unresolved items and existing destinations, writing nothing
        const noWrites = (m) => assert.ok(!m.calls.some((c) => ['writeFile', 'ensureDir', 'addServer', 'writeJson', 'createPlaybook'].includes(c[0])), 'nothing written');
        irows = await WP.reviewRows(ipkg, have2);   // Outlook clashes, no choice
        io = memIo();
        await assert.rejects(WP.installPackage(irows, ipkg, {}, io, have2), { message: 'install refused: unresolved items in the review' });
        noWrites(io);
        irows = await WP.reviewRows(ipkg, ihave);
        // a different skill of that name: the skill installer refuses (clash), nothing else is written
        io = memIo({ skillClash: true });
        await assert.rejects(WP.installPackage(irows, ipkg, { Outlook: { fillLater: true } }, io, ihave), /install failed at "install skill pdf"/);
        assert.ok(!io.calls.some((c) => ['writeFile', 'addServer', 'writeJson', 'createPlaybook'].includes(c[0])), 'nothing written after the clash');
        io = memIo({ fs: { 'mcps/outlook_mcp/server.py': 'mine', 'playbooks/triage.md': 'mine' } });
        await assert.rejects(WP.installPackage(irows, ipkg, { Outlook: { fillLater: true } }, io, ihave),
            { message: 'install refused: would overwrite mcps/outlook_mcp, playbooks/triage.md' });
        noWrites(io);
        // a local server not registered here whose folder is already there: clash; use-existing registers it, writes nothing in it
        {
            const fhave = { ...ihave, serverFolders: ['outlook_mcp'] };
            const frows = await WP.reviewRows(ipkg, fhave);
            const fr = frows.find((r) => r.kind === 'server' && r.name === 'Outlook');
            assert.strictEqual(fr.status, 'clash');
            assert.ok(fr.reasons.includes('folder-exists'));
            assert.strictEqual(WP.canConfirm(frows, {}), false);
            fr.choice = 'use-existing';
            for (const r of frows) if (r !== fr && r.kind !== 'server') r.choice = 'skip';
            assert.strictEqual(WP.canConfirm(frows, {}), true);
            const fio = memIo({ fs: { 'mcps/outlook_mcp/server.py': 'mine', 'mcps/outlook_mcp/.env': 'MINE=1' } });
            const fres = await WP.installPackage(frows, ipkg, { Outlook: { url: 'http://localhost:9000/mcp' } }, fio, fhave);
            assert.strictEqual(fio.fs['mcps/outlook_mcp/server.py'], 'mine');
            assert.strictEqual(fio.fs['mcps/outlook_mcp/.env'], 'MINE=1');
            assert.ok(!fio.calls.some((c) => c[0] === 'writeFile'));
            const fadds = fio.calls.filter((c) => c[0] === 'addServer');
            assert.deepStrictEqual(fadds.map((c) => [c[1].name, c[1].url]), [['Outlook', 'http://localhost:9000/mcp']]);
            assert.deepStrictEqual(JSON.parse(fio.fs['mcps/servers.json']), { Outlook: 'outlook_mcp' });
            assert.strictEqual(fres.nodes.find((n) => n.id === '1').config.store, 'mcp:100');
            assert.deepStrictEqual(fres.installed.map((x) => [x.kind, x.name, x.destination]), [['server', 'Outlook', 'mcps/outlook_mcp']]);
            assert.deepStrictEqual(fres.commands, [{ server: 'Outlook', install: srvMan.install, start: srvMan.start }]);
        }

        // host mode: files go to installServer, not writeFile; the address is the gateway's
        {
            const hhave = { ...ihave, host: { gateway: 'http://localhost:8790' }, hostFolders: [] };
            const hrows = await WP.reviewRows(ipkg, hhave);
            assert.ok(!hrows.find((r) => r.name === 'Outlook').reasons.includes('localhost-url'));
            const hio = memIo();
            const hres = await WP.installPackage(hrows, ipkg, { Outlook: { TENANT_ID: 't' } }, hio, hhave);
            assert.ok(!hio.calls.some((c) => (c[0] === 'writeFile' && c[1].startsWith('mcps/')) || c[0] === 'writeJson'));
            const inst = hio.calls.find((c) => c[0] === 'installServer');
            assert.strictEqual(inst[1], 'outlook_mcp');
            assert.ok('server.py' in inst[2].files && !('.env' in inst[2].files));
            assert.deepStrictEqual({ ...inst[2].env }, { TENANT_ID: 't', PORT: '8765' });
            assert.strictEqual(hio.calls.find((c) => c[0] === 'addServer')[1].url, 'http://localhost:8790/outlook_mcp/mcp');
            assert.ok(hres.installed.some((x) => x.kind === 'server' && x.destination === 'volume: outlook_mcp' && x.state === 'running'));
            assert.deepStrictEqual(hres.commands, []);
            assert.ok(!hio.calls.some((c) => c[0] === 'ensureDir' && c[1] === 'mcps'));
            // a non-local server with a localhost address keeps its warning in host mode
            const nl = { ...ipkg, servers: ipkg.servers.map((x) => (x.name === 'Hosted' ? { ...x, url: 'http://localhost:1/mcp' } : x)) };
            assert.ok((await WP.reviewRows(nl, hhave)).find((r) => r.name === 'Hosted').reasons.includes('localhost-url'));
            // use-existing on a volume folder registers the gateway address, no commands
            {
                const uh = { ...hhave, hostFolders: ['outlook_mcp'] };
                const urows = await WP.reviewRows(ipkg, uh);
                for (const r of urows) r.choice = r.name === 'Outlook' ? 'use-existing' : (r.kind === 'server' && r.status === 'present') ? r.choice : 'skip';
                const uio = memIo();
                const ures = await WP.installPackage(urows, ipkg, {}, uio, uh);
                assert.strictEqual(uio.calls.find((c) => c[0] === 'addServer')[1].url, 'http://localhost:8790/outlook_mcp/mcp');
                assert.ok(!uio.calls.some((c) => c[0] === 'installServer'));
                assert.deepStrictEqual(ures.commands, []);
            }
            // fill later: no env
            const lio = memIo();
            await WP.installPackage(hrows, ipkg, { Outlook: { fillLater: true } }, lio, hhave);
            assert.deepStrictEqual({ ...lio.calls.find((c) => c[0] === 'installServer')[2].env }, {});
            // a folder already in the volume is a clash
            const crow = (await WP.reviewRows(ipkg, { ...hhave, hostFolders: ['outlook_mcp'] })).find((r) => r.name === 'Outlook');
            assert.strictEqual(crow.status, 'clash');
            // a host without a gateway address is refused before anything is installed or registered
            const gio = memIo();
            await assert.rejects(WP.installPackage(hrows, ipkg, { Outlook: { fillLater: true } }, gio, { ...hhave, host: { gateway: '' } }), /no gateway address/);
            assert.ok(!gio.calls.some((c) => c[0] === 'installServer' || c[0] === 'addServer'));
            // install failure stops before registering
            const fio2 = memIo({ failInstall: 'outlook_mcp' });
            await assert.rejects(WP.installPackage(hrows, ipkg, { Outlook: { fillLater: true } }, fio2, hhave), /install failed at "install server Outlook"/);
            assert.ok(!fio2.calls.some((c) => c[0] === 'addServer'));
        }

        // a component folder copy takes the next free name
        io = memIo({ fs: { 'components/Make_PDF.json': 'mine' } });
        res = await WP.installPackage(irows, ipkg, { Outlook: { fillLater: true } }, io, ihave);
        assert.strictEqual(io.fs['components/Make_PDF.json'], 'mine');
        assert.ok(io.fs['components/Make_PDF_2.json'].includes('Make PDF'));
        assert.strictEqual(res.installed.find((x) => x.kind === 'component').destination, 'components/Make_PDF_2.json');

        // ---- final review fixes: path confinement (finding 1)
        {
            const P = WP.isSafeWritePath;
            assert.strictEqual(P('skills/pdf/SKILL.md', 'skills'), true);
            assert.strictEqual(P('skills', 'skills'), true);
            for (const bad of ['/x', '../x', 'skills/../python/x', 'skills/a\\b/c', 'skills/a//b', 'skills/./a', 'python/x', 'skills/.venv/x', 'skills/a/.hidden'])
                assert.strictEqual(P(bad, 'skills'), false, bad);
            assert.strictEqual(P('mcps/x/.env', 'mcps'), false);
            assert.strictEqual(P('mcps/x/.env', 'mcps', true), true);
            assert.strictEqual(P('mcps/x/.env.example', 'mcps'), true);
            assert.strictEqual(P('mcps/x/.git/config', 'mcps', true), false);
            assert.strictEqual(P('python/.venv/lib/python3.13/site-packages/zz.pth', 'mcps'), false);
            assert.strictEqual(P('skills/x', 'python'), false);
            assert.ok(WP.isSafeSegment('outlook_mcp'));
            for (const bad of ['', '.', '..', 'a/b', 'a\\b', '.venv', 'x..y', null]) assert.ok(!WP.isSafeSegment(bad), String(bad));

            const writesOf = (m) => m.calls.filter((c) => c[0] === 'writeFile' || c[0] === 'writeJson').map((c) => c[1]);
            const insideRoots = (m) => writesOf(m).every((p) => ['skills/', 'mcps/', 'components/', 'playbooks/'].some((r) => p.startsWith(r)) && !p.split('/').includes('..'));
            const pth = enc('import os; os.system("x")');
            const mkPkg = (deps, extra, servers = []) => WP.readPackage({
                'manifest.json': J({ format: 'synergyai-workflow-package', version: 1, workflow: { name: 'W' }, dependencies: deps }),
                'workflow.json': J({ definition: { nodes: [] } }),
                'mcps/servers.json': J(servers),
                ...extra,
            });
            const empty = { servers: [], playbooks: [], skills: [], components: [] };
            const unsafeRows = (rs) => rs.filter((r) => r.reasons.includes('unsafe-path'));

            // skills: only manifest entries, 1-2 safe segments; every file inside its folder
            for (const dir of ['../python', '/abs', 'a\\b', 'python/.venv', 'a/b/c', '..', '']) {
                const p = mkPkg([{ kind: 'skill', name: dir }], { [`skills/${dir}/SKILL.md`]: enc('s'), [`skills/${dir}/zz.pth`]: pth });
                const rs = await WP.reviewRows(p, empty);
                assert.strictEqual(unsafeRows(rs).length, 1, dir);
                assert.strictEqual(rs[0].status, 'attention');
                assert.strictEqual(WP.canConfirm(rs, {}), false, dir);
                rs[0].choice = 'skip';
                assert.strictEqual(WP.canConfirm(rs, {}), true);
                const m = memIo();
                await WP.installPackage(rs, p, {}, m, empty);
                assert.deepStrictEqual(writesOf(m), [], dir);
            }
            const trav = mkPkg([{ kind: 'skill', name: 'pdf' }], { 'skills/pdf/SKILL.md': enc('s'), 'skills/pdf/../../python/.venv/zz.pth': pth });
            let rs = await WP.reviewRows(trav, empty);
            assert.deepStrictEqual(rs.map((r) => [r.name, r.reasons]), [['pdf', ['unsafe-path']]]);
            // forged rows (the review bypassed): the installer's own check refuses before any write
            let m = memIo();
            await assert.rejects(WP.installPackage([{ kind: 'skill', name: 'pdf', status: 'install', reasons: [], choice: null, destination: 'skills/pdf' }], trav, {}, m, empty),
                /install refused: unsafe path skills\/pdf\/\.\.\/\.\.\/python/);
            assert.deepStrictEqual(m.calls, []);
            m = memIo();
            await assert.rejects(WP.installPackage([{ kind: 'skill', name: '../python', status: 'install', reasons: [], choice: null, destination: 'python' }],
                mkPkg([{ kind: 'skill', name: '../python' }], { 'skills/../python/zz.pth': pth }), {}, m, empty), /install refused: unsafe path skill \.\.\/python/);
            assert.deepStrictEqual(m.calls, []);
            // a nested SKILL.md no longer makes a phantom row; a folder in the zip the manifest doesn't name is ignored
            rs = await WP.reviewRows(mkPkg([{ kind: 'skill', name: 'pdf' }], { 'skills/pdf/SKILL.md': enc('s'), 'skills/pdf/sub/SKILL.md': enc('t'), 'skills/other/SKILL.md': enc('o') }), empty);
            assert.deepStrictEqual(rs.map((r) => [r.kind, r.name, r.status]), [['skill', 'pdf', 'install']]);
            rs = await WP.reviewRows(mkPkg([{ kind: 'skill', name: 'gone' }], {}), empty);
            assert.deepStrictEqual(rs[0].reasons, ['unreadable']);

            // servers: folder from the manifest must be mcps/<safe segment>; else the server name; files stay inside
            const local = (name) => [{ name, url: 'https://h.example/mcp', local: true, old_id: 4 }];
            for (const [folder, name, extra] of [
                ['mcps/../python/', 'S', {}],
                ['python/.venv/lib/python3.13/site-packages/', 'S', {}],
                ['mcps/.venv/', 'S', {}],
                ['mcps/a\\b/', 'S', {}],
                [undefined, '../evil', {}],
                [undefined, '/abs', {}],
                ['mcps/outlook_mcp/', 'S', { 'mcps/outlook_mcp/../../python/.venv/lib/python3.13/site-packages/zz.pth': pth }],
                ['mcps/outlook_mcp/', 'S', { 'mcps/outlook_mcp/sub\\..\\..\\zz.pth': pth }],
                ['mcps/outlook_mcp/', 'S', { 'mcps/outlook_mcp/.venv/lib/zz.pth': pth }],
            ]) {
                const dep = { kind: 'server', name, old_id: 4, local: true, ...(folder !== undefined ? { folder } : {}) };
                const p = mkPkg([dep], { 'mcps/outlook_mcp/server.py': enc('x'), ...extra }, local(name));
                const rs2 = await WP.reviewRows(p, empty);
                assert.deepStrictEqual(rs2[0].reasons, ['unsafe-path'], String(folder) + name);
                assert.strictEqual(rs2[0].destination, null);
                assert.strictEqual(WP.canConfirm(rs2, {}), false);
                const m2 = memIo();
                await assert.rejects(WP.installPackage(rs2, p, {}, m2, empty), /unresolved/);
                rs2[0].status = 'install'; rs2[0].reasons = [];   // forged past the review
                await assert.rejects(WP.installPackage(rs2, p, {}, m2, empty), /install refused: unsafe path/);
                assert.deepStrictEqual(m2.calls, [], String(folder) + name);
            }

            // playbooks: written to playbooks/<pkey>.md whatever the manifest's file says; a bad key is refused
            const pbMd = enc(WP.playbookToMd({ pkey: 'triage', title: 'T', text: 'b' }));
            let p = mkPkg([{ kind: 'playbook', name: 'T', pkey: 'triage', old_id: 3, file: 'python/.venv/lib/python3.13/site-packages/zz.pth' }],
                { 'python/.venv/lib/python3.13/site-packages/zz.pth': pbMd });
            rs = await WP.reviewRows(p, empty);
            m = memIo();
            let r2 = await WP.installPackage(rs, p, {}, m, empty);
            assert.deepStrictEqual(writesOf(m), ['playbooks/triage.md']);
            assert.strictEqual(r2.installed[0].destination, 'playbooks/triage.md');
            for (const pkey of ['../x', '/x', 'a\\b', 'Triage', 'a/b', '']) {
                p = mkPkg([{ kind: 'playbook', name: 'T', pkey, old_id: 3, file: 'playbooks/x.md' }], { 'playbooks/x.md': pbMd });
                rs = await WP.reviewRows(p, empty);
                assert.deepStrictEqual(rs[0].reasons, ['unsafe-path'], pkey);
                assert.strictEqual(WP.canConfirm(rs, {}), false);
            }
            // an unreadable playbook file is a review item, not a crash
            p = mkPkg([{ kind: 'playbook', name: 'T', pkey: 'triage', old_id: 3, file: 'playbooks/triage.md' }], { 'playbooks/triage.md': enc('no front matter') });
            rs = await WP.reviewRows(p, empty);
            assert.deepStrictEqual([rs[0].status, rs[0].reasons], ['attention', ['unreadable']]);

            // components: components/<safe name>.json whatever the manifest's file says
            p = mkPkg([{ kind: 'component', name: '../../python/.venv/zz', old_id: 12, file: 'python/.venv/zz.pth' }], { 'python/.venv/zz.pth': J(comp) });
            rs = await WP.reviewRows(p, empty);
            m = memIo();
            await WP.installPackage(rs, p, {}, m, empty);
            assert.deepStrictEqual(writesOf(m), ['components/python_.venv_zz.json']);
            assert.ok(insideRoots(m));
        }

        // ---- finding 3: ids no row maps are cleared and flagged
        {
            const p = WP.readPackage({
                'manifest.json': J({ format: 'synergyai-workflow-package', version: 1, workflow: { name: 'W' }, dependencies: [
                    { kind: 'playbook', name: 'Gone', pkey: 'gone', old_id: 5, file: 'playbooks/gone.md' },   // file not in the zip
                ] }),
                'workflow.json': J({ definition: { nodes: [
                    { id: '1', node_type: 'vectorstore', config: { store: 'mcp:66' } },        // server not exported
                    { id: '2', node_type: 'playbook', config: { playbook_id: 5 } },            // missing file
                    { id: '3', node_type: 'agent', config: { playbook_id: 8 } },               // never exported
                    { id: '4', node_type: 'code', config: { code_component_id: 12 } },         // not bundled
                    { id: '5', node_type: 'loader', config: { store: 'local:x' } },            // not an id: kept
                    { id: '6', node_type: 'start', config: { start_option: 9 } },              // not bundled
                ] } }),
            });
            const empty = { servers: [], playbooks: [], skills: [], components: [] };
            const rs = await WP.reviewRows(p, empty);
            const m = memIo();
            const res2 = await WP.installPackage(rs, p, {}, m, empty);
            const n = (id) => res2.nodes.find((x) => x.id === id).config;
            assert.deepStrictEqual([n('1').store, n('1').store_missing], ['', true]);
            assert.deepStrictEqual([n('2').playbook_id, n('2').playbook_missing], [null, true]);
            assert.deepStrictEqual([n('3').playbook_id, n('3').playbook_missing], [null, true]);
            assert.deepStrictEqual([n('4').code_component_id, n('4').code_component_missing], [null, true]);
            assert.deepStrictEqual(n('5'), { store: 'local:x' });
            assert.deepStrictEqual([n('6').start_option, n('6').start_option_missing], [null, true]);
            // the missing badge sees the flags (with or without the other sources known)
            const mb = WP.missingByNode(res2.nodes, { skills: null, servers: null, tools: null, playbookIds: null });
            assert.deepStrictEqual(mb, { 1: ['store_missing:'], 2: ['playbook_missing:'], 3: ['playbook_missing:'] });
            // a new link clears the marker
            assert.deepStrictEqual(WP.missingByNode([{ id: '2', node_type: 'playbook', config: { playbook_id: 7, playbook_missing: true } }], { playbookIds: [7] }), {});
            assert.deepStrictEqual(WP.missingByNode([{ id: '1', node_type: 'vectorstore', config: { store: 'mcp:1', store_missing: true } }], {}), {});
            // the plain relink (no clearUnmapped) is unchanged
            assert.strictEqual(WP.relinkNodes([{ node_type: 'agent', config: { playbook_id: 8 } }], { playbookIdByOldId: new Map() })[0].config.playbook_id, 8);
        }

        // ---- finding 5: review values are own properties; no server name reaches the workflow keys
        {
            const p = WP.readPackage({
                'manifest.json': J({ format: 'synergyai-workflow-package', version: 1, workflow: { name: 'W' }, strippedSecrets: [{ node: '1', field: 'api_key' }],
                    dependencies: [{ kind: 'server', name: 'workflow keys', old_id: 1 }, { kind: 'server', name: '__proto__', old_id: 2 }] }),
                'workflow.json': J({ definition: { nodes: [{ id: '1', node_type: 'vectorstore', config: { store: 'mcp:1', connection: {} } }] } }),
                'mcps/servers.json': J([{ name: 'workflow keys', url: 'https://a.example/mcp', old_id: 1 }, { name: '__proto__', url: 'https://b.example/mcp', old_id: 2 }]),
            });
            const empty = { servers: [], playbooks: [], skills: [], components: [] };
            const rs = await WP.reviewRows(p, empty);
            const values = Object.create(null);
            values[WP.WORKFLOW_KEYS] = Object.assign(Object.create(null), { '1.api_key': 'K' });
            values['workflow keys'] = Object.assign(Object.create(null), { url: 'https://evil.example', '1.api_key': 'X' });
            values['__proto__'] = Object.assign(Object.create(null), { authorization: 'Bearer z' });
            const m = memIo();
            const res2 = await WP.installPackage(rs, p, values, m, empty);
            assert.strictEqual(res2.nodes[0].config.connection.api_key, 'K');
            const adds = m.calls.filter((c) => c[0] === 'addServer').map((c) => c[1]);
            assert.deepStrictEqual(adds.map((a) => [a.name, a.url, a.headers]), [['workflow keys', 'https://evil.example', {}], ['__proto__', 'https://b.example/mcp', { Authorization: 'Bearer z' }]]);
            assert.strictEqual({}.authorization, undefined);   // nothing polluted
            // a plain {} values object: inherited names are not read as values
            assert.strictEqual(WP.canConfirm([{ kind: 'server', name: 'constructor', status: 'install', reasons: [], choice: null, envFields: [{ name: 'A', required: true }] }], {}), false);
            assert.deepStrictEqual(WP.missingRequired([{ name: 'constructor', required: true }], {}), ['constructor']);
        }
    }
    console.log('workflow-package: ok');
})().catch((e) => { console.error(e); process.exit(1); });

// missingByNode: what each node needs that this install lacks (null source = unknown, skipped).
{
    const have = {
        skills: ['Other/skill'],
        servers: [{ id: 1, name: 'outlook' }],
        tools: new Map([['known_tool', ['outlook']]]),
        playbookIds: [3],
    };
    const ns = [
        { id: '1', node_type: 'agent', config: { bound_skill: { dir_name: 'GEO/geo-compare' }, tools: ['known_tool', 'ghost_tool'], playbook_id: 9 } },
        { id: '2', node_type: 'code', config: { mcp_servers: ['Outlook', 'Workday'] } },
        { id: '3', node_type: 'vectorstore', config: { store: 'mcp:7' } },
        { id: '4', node_type: 'vectorstore', config: { store: 'mcp:1' } },
        { id: '5', node_type: 'playbook', config: { playbook_id: 3 } },
        { id: '6', node_type: 'playbook', config: { playbook_id: 4 } },
        { id: '7', node_type: 'agent', config: { bound_skill: { dir_name: 'Other/skill' } } },
    ];
    const r = WP.missingByNode(ns, have);
    assert.deepStrictEqual(r['1'], ['skill:GEO/geo-compare', 'tool:ghost_tool', 'playbook:9']);
    assert.deepStrictEqual(r['2'], ['server:Workday']);
    assert.deepStrictEqual(r['3'], ['store:7']);
    assert.deepStrictEqual(r['6'], ['playbook:4']);
    for (const id of ['4', '5', '7']) assert.strictEqual(r[id], undefined);
    const none = WP.missingByNode(ns, { skills: null, servers: null, tools: null, playbookIds: null });
    assert.deepStrictEqual(none, {});
    console.log('missingByNode: ok');
}

{
  const b64 = (s) => Buffer.from(s).toString('base64');
  assert.strictEqual(WP.hostFolderOf('http://localhost:8790/outlook_mcp/mcp', 'http://localhost:8790/'), 'outlook_mcp');
  assert.strictEqual(WP.hostFolderOf('http://localhost:9000/x/mcp', 'http://localhost:8790'), null);
  assert.strictEqual(WP.hostFolderOf('http://localhost:8790/.git/mcp', 'http://localhost:8790'), null);
  assert.strictEqual(WP.hostFolderOf('http://localhost:8790/a/mcp', ''), null);
  const r = WP.hostSourceFiles('outlook_mcp', { files: {
    'server.py': b64('print(1)'), 'sub/a.txt': b64('x'), 'synergyai-mcp.json': b64('{"exclude":["x"]}'), '../evil': b64('no') } });
  assert.deepStrictEqual(Object.keys(r.files).sort(),
    ['mcps/outlook_mcp/server.py', 'mcps/outlook_mcp/sub/a.txt', 'mcps/outlook_mcp/synergyai-mcp.json']);
  assert.strictEqual(Buffer.from(r.files['mcps/outlook_mcp/server.py']).toString(), 'print(1)');
  assert.deepStrictEqual(r.manifest, { exclude: ['x'] });
  assert.strictEqual(WP.hostSourceFiles('f', { files: {} }).manifest, null);
  const e = WP.hostSourceFiles('f', { files: { '.env.example': b64('A=1'), '.env': b64('S=1'), 'd/.env': b64('S'), '.hidden/x': b64('x') } });
  assert.deepStrictEqual(Object.keys(e.files), ['mcps/f/.env.example']);
  console.log('hostSourceFiles: ok');
}
