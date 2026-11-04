import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const SRC = readFileSync(fileURLToPath(new URL('../assets/js/skills-manager.js', import.meta.url)), 'utf8');

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function load({ fs = {}, store = {}, uid = 7 } = {}) {
  const document = {
    addEventListener() {},
    getElementById: () => null,
    createElement: () => {
      const el = { set textContent(v) { this._t = v; }, get innerHTML() { return esc(this._t); } };
      return el;
    },
  };
  const localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
  };
  const window = { skillsFs: fs, authManager: { user: { id: uid } }, document, localStorage };
  const ctx = vm.createContext({ window, document, localStorage, console });
  vm.runInContext(SRC, ctx);
  const Cls = vm.runInContext('SkillsManager', ctx);
  const mgr = new Cls('/api', () => ({}), (k, p) => k + (p ? JSON.stringify(p) : ''));
  return { mgr, window, store };
}

const skill = (o) => ({
  id: `local:${o.dir_name}`, name: o.dir_name, description: '', source: 'local', group: null,
  tags: [], spec_compliant: true, spec_issues: [], visibility: 'private', mine: true, ...o,
});
const SKILLS = [
  skill({ dir_name: 'mine-priv' }),
  skill({ dir_name: 'mine-pub', visibility: 'public' }),
  skill({ dir_name: 'theirs-pub', visibility: 'public', mine: false, ownerId: 9 }),
];

test('corporate edition renders Public and Private sections', () => {
  const { mgr } = load();
  mgr.edition = 'corporate';
  const html = mgr.buildTreeHtml(SKILLS, '');
  assert.match(html, /skills\.section\.public/);
  assert.match(html, /skills\.section\.private/);
  const [pub, priv] = html.split('data-section="private"');
  assert.ok(pub.includes('mine-pub') && pub.includes('theirs-pub') && !pub.includes('mine-priv'));
  assert.ok(priv.includes('mine-priv') && !priv.includes('theirs-pub'));
});

test('other editions render one plain list without headings', () => {
  for (const edition of ['individual', '']) {
    const { mgr } = load();
    mgr.edition = edition;
    const html = mgr.buildTreeHtml(SKILLS, '');
    assert.doesNotMatch(html, /skills-section|skills\.section/);
    assert.ok(html.includes('mine-priv') && html.includes('theirs-pub'));
  }
});

test('visibility toggle only on my own skills, only in corporate', () => {
  const { mgr } = load();
  mgr.edition = 'corporate';
  assert.match(mgr.renderSkillItem(SKILLS[0]), /skills-item-visibility/);
  assert.doesNotMatch(mgr.renderSkillItem(SKILLS[2]), /skills-item-visibility/);
  mgr.edition = 'individual';
  assert.doesNotMatch(mgr.renderSkillItem(SKILLS[0]), /skills-item-visibility/);
});

test('toggling visibility shows the robot workflows that block it', async () => {
  const alerts = [];
  const fs = { setVisibility: async () => { const e = new Error('409'); e.status = 409; e.data = { success: false, data: { message: 'in use by robot workflows', robot_workflows: [{ id: 1, name: 'Nightly' }, { id: 2, name: 'Weekly' }] }, error: 'in use by robot workflows' }; throw e; } };
  const { mgr, window } = load({ fs });
  window.alert = (m) => alerts.push(m);
  mgr.loadTree = async () => {};
  mgr.notify = (m) => alerts.push(m);
  await mgr.toggleVisibility(SKILLS[1]);
  assert.equal(alerts.length, 1);
  assert.ok(alerts[0].includes('Nightly') && alerts[0].includes('Weekly'));
});

test('toggling visibility explains a clash from the real error body', async () => {
  const alerts = [];
  const fs = { setVisibility: async () => { const e = new Error('409'); e.status = 409; e.data = { success: false, data: { message: 'taken', clash: 'different' }, error: 'taken' }; throw e; } };
  const { mgr } = load({ fs });
  mgr.loadTree = async () => {};
  mgr.notify = (m) => alerts.push(m);
  await mgr.toggleVisibility(SKILLS[1]);
  assert.equal(alerts.length, 1);
  assert.match(alerts[0], /clash/);
});

test('toggling flips public to private and back', async () => {
  const calls = [];
  const fs = { setVisibility: async (p, v) => { calls.push([p, v]); return {}; } };
  const { mgr } = load({ fs });
  mgr.loadTree = async () => {};
  await mgr.toggleVisibility(SKILLS[1]);
  await mgr.toggleVisibility(SKILLS[0]);
  assert.deepEqual(calls, [['mine-pub', 'private'], ['mine-priv', 'public']]);
});

test('making public goes through SkillVisibilityCard.makePublic; a cancelled confirmation changes nothing', async () => {
  const asked = [];
  let loads = 0;
  const { mgr, window } = load({ fs: { setVisibility: async () => { throw new Error('not direct'); } } });
  window.SkillVisibilityCard = { makePublic: async (p) => { asked.push(p); return { done: false }; } };
  mgr.loadTree = async () => { loads++; };
  await mgr.toggleVisibility(SKILLS[0]);
  assert.deepEqual(asked, ['mine-priv']);
  assert.equal(loads, 0);
});

test('making private refused because public skills need it: the translated reason names them', async () => {
  const alerts = [];
  const err = Object.assign(new Error('409'), { status: 409, data: { success: false, data: { reason: 'private', skill: 'mine-pub', required_by: ['auto'] } } });
  const { mgr, window } = load({ fs: { setVisibility: async () => { throw err; } } });
  window.skillsFs.requiredByMessage = (d, t) => t(`skills.requiredBy.${d.reason}`, { name: d.skill, dependents: d.required_by.join(', ') });
  mgr.loadTree = async () => {};
  mgr.notify = (m) => alerts.push(m);
  await mgr.toggleVisibility(SKILLS[1]);
  assert.deepEqual(alerts, ['skills.requiredBy.private{"name":"mine-pub","dependents":"auto"}']);
});

const folderSkills = [{ dirName: 'a', path: 'a' }];
const offerFs = (o = {}) => ({
  mode: async () => 'volume',
  listSkills: async () => [skill({ dir_name: 'x', mine: false, visibility: 'public' })],
  listFolderSkills: async () => folderSkills,
  ...o,
});

test('migration offer: shown only for volume mode + no own skills + folder skills + not done', async () => {
  assert.deepEqual((await load({ fs: offerFs() }).mgr.migrationOffer()), folderSkills);
  assert.equal(await load({ fs: offerFs({ mode: async () => 'folder' }) }).mgr.migrationOffer(), null);
  assert.equal(await load({ fs: offerFs({ listSkills: async () => [skill({ dir_name: 'm' })] }) }).mgr.migrationOffer(), null);
  assert.equal(await load({ fs: offerFs({ listFolderSkills: async () => [] }) }).mgr.migrationOffer(), null);
  assert.equal(await load({ fs: offerFs(), store: { skills_migrate_done_7: '1' } }).mgr.migrationOffer(), null);
});

test('migration import: results per skill, wheel failure and clash are not fatal, remembered per user', async () => {
  const imported = [];
  const list = [
    { dirName: 'ok', path: 'ok', dependencies: [] },
    { dirName: 'dup', path: 'dup', dependencies: [] },
    { dirName: 'wh', path: 'wh', dependencies: ['numpy'] },
    { dirName: 'same', path: 'same', dependencies: [] },
  ];
  const fs = offerFs({
    readFolderSkillFiles: async (p) => ({ 'SKILL.md': new Uint8Array([1]) }),
    importSkill: async (read, o) => {
      imported.push([read.dir, o.visibility]);
      if (read.dir === 'dup') { const e = new Error('c'); e.code = 'clash'; throw e; }
      if (read.dir === 'same') return { status: 'identical' };
      return { status: 'installed' };
    },
  });
  const { mgr, window, store } = load({ fs });
  window.SkillWheels = { gather: async (deps) => { if (deps.length) throw new Error('offline'); return { pyodide: {}, native: {} }; } };
  const res = await mgr.runMigration(list);
  assert.deepEqual(Array.from(res, (r) => [r.path, r.status]), [['ok', 'installed'], ['dup', 'clash'], ['wh', 'failed'], ['same', 'exists']]);
  assert.match(res[2].message, /offline/);
  assert.deepEqual(imported.map((i) => i[1]), ['private', 'private', 'private']);
  assert.equal(store.skills_migrate_done_7, '1');
});

test('declining the offer is remembered per user', () => {
  const { mgr, store } = load();
  mgr.markMigrationDone();
  assert.equal(store.skills_migrate_done_7, '1');
});

test('others\' public skills show their owner and stay draggable (to chat)', () => {
  const { mgr } = load();
  mgr.edition = 'corporate';
  const theirs = mgr.renderSkillItem({ ...SKILLS[2], owner_name: 'Ada' });
  assert.match(theirs, /skills\.visibility\.by\{"name":"Ada"\}/);
  assert.match(theirs, /draggable="true"/);
  const mine = mgr.renderSkillItem({ ...SKILLS[1], owner_name: 'Ada' });
  assert.doesNotMatch(mine, /skills\.visibility\.by/);
  assert.match(mine, /draggable="true"/);
});

test('dropping a skill that is not mine on a folder moves nothing', async () => {
  const moved = [];
  const { mgr } = load({ fs: { moveSkill: async (...a) => { moved.push(a); return { ok: true }; } } });
  mgr.loadTree = async () => {};
  const drop = (p) => ({ dataTransfer: { getData: () => JSON.stringify(p) } });
  await mgr.handleSkillDropOnFolder(drop({ source: 'local', dir_name: 'x', mine: false }), 'g');
  assert.equal(moved.length, 0);
  await mgr.handleSkillDropOnFolder(drop({ source: 'local', dir_name: 'x', mine: true }), 'g');
  assert.equal(moved.length, 1);
});

test('no migration offer and no flag without a current user id', async () => {
  const { mgr, window, store } = load({ fs: offerFs() });
  window.authManager = { user: null };
  assert.equal(await mgr.migrationOffer(), null);
  mgr.markMigrationDone();
  assert.deepEqual(Object.keys(store), []);
});

test('folder-permission notice only in folder mode (an empty Docker store is not a folder problem)', async () => {
  for (const [mode, expected] of [['volume', false], ['folder', true]]) {
    const { mgr, window } = load({ fs: { mode: async () => mode } });
    window.localFs = { getStatus: async () => ({ state: 'prompt' }) };
    mgr.treeContainer = { innerHTML: '' };
    assert.equal(await mgr.renderFsAccessNotice(), expected, mode);
    assert.equal(mgr.treeContainer.innerHTML.includes('skills.fsaPrompt'), expected, mode);
  }
});

test('import review summarizes the skill folder: SKILL.md first, folders with counts, loose files, total size', () => {
  const { mgr } = load();
  const b = (n) => new Uint8Array(n);
  const s = mgr.constructor.summarizeSkillFiles({
    'SKILL.md': b(100), 'scripts/a.py': b(10), 'scripts/b.py': b(10), 'references/r.md': b(30), 'LICENSE': b(50),
  });
  assert.equal(s.total, 5);
  assert.equal(s.bytes, 200);
  assert.equal(JSON.stringify(s.groups.map((g) => [g.kind, g.name, g.count])),
    JSON.stringify([['skillmd', 'SKILL.md', 1], ['folder', 'references/', 1], ['folder', 'scripts/', 2], ['loose', '', 1]]));
});

// ---- expandable entries: a skill shows the skills it requires ----
const TREE = [
  skill({ dir_name: 'app', requires: ['mid', 'solo'] }),
  skill({ dir_name: 'mid', requires: ['leaf'] }),
  skill({ dir_name: 'leaf' }),
  skill({ dir_name: 'solo' }),
];
const rowOf = (html, dir) => html.split('<div class="skills-item').find((c) => c.includes(`data-skill-id="local:${dir}"`)) || '';
const childIds = (html) => [...html.matchAll(/skills-req-item[^>]*data-skill-id="([^"]+)"/g)].map((m) => m[1]);

test('a skill with requirements shows an arrow and a needs badge; others do not', () => {
  const { mgr } = load();
  const html = mgr.buildTreeHtml(TREE, '');
  assert.match(rowOf(html, 'app'), /skills-req-toggle/);
  assert.match(rowOf(html, 'app'), /skills\.needsTree\.needs\{"count":2\}/);
  assert.doesNotMatch(rowOf(html, 'leaf'), /skills-req-toggle|needsTree\.needs/);
});

test('collapsed: no children; expanded: direct requirements only; they stay top-level entries too', () => {
  const { mgr } = load();
  assert.deepEqual(childIds(mgr.buildTreeHtml(TREE, '')), []);
  mgr.expandedSkills.add('app');
  const html = mgr.buildTreeHtml(TREE, '');
  assert.deepEqual(childIds(html), ['local:mid', 'local:solo']);     // not leaf: direct only
  for (const d of ['app', 'mid', 'leaf', 'solo']) assert.ok(rowOf(html, d), `${d} stays a normal entry`);
});

test('a child that is itself expandable has its own arrow and expands nested', () => {
  const { mgr } = load();
  mgr.expandedSkills.add('app');
  assert.match(mgr.buildTreeHtml(TREE, ''), /skills-req-item[^>]*data-skill-id="local:mid"[\s\S]*?skills-req-toggle/);
  mgr.expandedSkills.add('mid');
  // under app: mid (open) > leaf, then solo; the top-level mid row is open too: leaf
  assert.deepEqual(childIds(mgr.buildTreeHtml(TREE, '')), ['local:mid', 'local:leaf', 'local:solo', 'local:leaf']);
});

test('requirement cycles never expand a skill already open in the branch', () => {
  const { mgr } = load();
  const cyc = [skill({ dir_name: 'a', requires: ['b'] }), skill({ dir_name: 'b', requires: ['a'] })];
  mgr.expandedSkills.add('a'); mgr.expandedSkills.add('b');
  const html = mgr.buildTreeHtml(cyc, '');
  // top-level a -> child b -> child a (plain, no arrow, nothing below); top-level b -> child a -> child b (plain)
  assert.equal(childIds(html).length, 4);
  assert.equal((html.match(/skills-req-toggle/g) || []).length, 4);   // 2 top-level rows + b under a + a under b
});

test('used-by hint on a required skill lists the names in its tooltip', () => {
  const { mgr } = load();
  const html = mgr.buildTreeHtml(TREE, '');
  assert.match(rowOf(html, 'leaf'), /skills\.needsTree\.usedBy\{"count":1\}/);
  assert.match(rowOf(html, 'leaf'), /skills\.needsTree\.usedByTitle\{"names":"mid"\}/);
  assert.doesNotMatch(rowOf(html, 'app'), /usedBy/);
});

test('search hiding a parent keeps its children hidden; a visible parent still shows them', () => {
  const { mgr } = load();
  mgr.skills = TREE;
  mgr.expandedSkills.add('app');
  const html = mgr.buildTreeHtml(TREE.filter((s) => s.dir_name === 'mid'), 'mid');
  assert.ok(rowOf(html, 'mid'));
  assert.deepEqual(childIds(html), []);
  const parent = mgr.buildTreeHtml(TREE.filter((s) => s.dir_name === 'app'), 'app');
  assert.deepEqual(childIds(parent), ['local:mid', 'local:solo']);
});

test('expanding works in both corporate sections; child rows are not draggable and have no menu', () => {
  const { mgr } = load();
  mgr.edition = 'corporate';
  const list = [skill({ dir_name: 'p', visibility: 'public', requires: ['q'] }), skill({ dir_name: 'q', visibility: 'public', mine: false, ownerId: 9 }),
    skill({ dir_name: 'r', requires: ['q'] })];
  mgr.expandedSkills.add('p'); mgr.expandedSkills.add('r');
  const html = mgr.buildTreeHtml(list, '');
  const [pub, priv] = html.split('data-section="private"');
  assert.deepEqual(childIds(pub), ['local:q']);
  assert.deepEqual(childIds(priv), ['local:q']);
  const child = html.split('skills-req-item')[1].split('</div>')[0];
  assert.doesNotMatch(child, /draggable="true"|skills-item-menu/);
});

test('picker mode (expandable:false) renders plain rows', () => {
  const { mgr } = load();
  mgr.expandedSkills.add('app');
  const html = mgr.buildTreeHtml(TREE, '', { expandable: false });
  assert.doesNotMatch(html, /skills-req-|needsTree/);
});

test('toggling an arrow flips expandedSkills and re-renders', () => {
  const { mgr } = load();
  let n = 0; mgr.renderTree = () => { n++; };
  mgr.toggleExpanded('app'); assert.ok(mgr.expandedSkills.has('app'));
  mgr.toggleExpanded('app'); assert.ok(!mgr.expandedSkills.has('app'));
  assert.equal(n, 2);
});

test('loadLocalSkills maps requires onto the skill objects', async () => {
  const fs = { listSkills: async () => [{ name: 'a', description: '', dirName: 'g/a', group: 'g', requires: ['b'] }],
    getSkillContent: async () => '', listSkillScripts: async () => [], listSkillReferences: async () => [] };
  const { mgr } = load({ fs });
  const [s] = await mgr.loadLocalSkills();
  assert.deepEqual([...s.requires], ['b']);
});

test('a folder row shows the open folder icon expanded and the closed one collapsed (no separate arrow)', () => {
  const { mgr } = load();
  const folder = { name: 'GEO', readme: null };
  const open = mgr.renderFolder(folder, [skill({ dir_name: 'GEO/a', group: 'GEO' })]);
  assert.match(open, /skills-folder-icon[^>]*data-state="open"[^>]*><svg/);
  assert.doesNotMatch(open, /📁|📂|▶|▼/);
  mgr.collapsedFolders.add('GEO');
  const closed = mgr.renderFolder(folder, []);
  assert.match(closed, /skills-folder-icon[^>]*data-state="closed"[^>]*><svg/);
  assert.match(mgr.renderExpandArrow('x'), />▶</);
  mgr.expandedSkills.add('x');
  assert.match(mgr.renderExpandArrow('x'), />▼</);
});
