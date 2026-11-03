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
  const fs = { setVisibility: async () => { const e = new Error('409'); e.status = 409; e.data = { robot_workflows: [{ id: 1, name: 'Nightly' }, { id: 2, name: 'Weekly' }] }; throw e; } };
  const { mgr, window } = load({ fs });
  window.alert = (m) => alerts.push(m);
  mgr.loadTree = async () => {};
  mgr.notify = (m) => alerts.push(m);
  await mgr.toggleVisibility(SKILLS[1]);
  assert.equal(alerts.length, 1);
  assert.ok(alerts[0].includes('Nightly') && alerts[0].includes('Weekly'));
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
