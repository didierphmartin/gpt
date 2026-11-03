import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const SRC = readFileSync(fileURLToPath(new URL('../assets/js/skill-visibility-card.js', import.meta.url)), 'utf8');

function el(tag) {
  const e = {
    tag, children: [], dataset: {}, style: {}, listeners: {}, className: '', _text: '', removed: false,
    set textContent(v) { this._text = String(v); this.children = []; },
    get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); },
    append(...c) { this.children.push(...c); },
    appendChild(c) { this.children.push(c); return c; },
    addEventListener(n, f) { this.listeners[n] = f; },
    click() { return this.listeners.click?.({ target: this }); },
    remove() { this.removed = true; },
    find(pred) {
      if (pred(this)) return this;
      for (const c of this.children) { const r = c.find(pred); if (r) return r; }
      return null;
    },
    findAll(pred, out = []) { if (pred(this)) out.push(this); this.children.forEach((c) => c.findAll(pred, out)); return out; },
  };
  return e;
}

function load(setVisibility) {
  const body = el('body');
  const document = { createElement: el, body };
  const window = { skillsFs: { setVisibility } };
  const ctx = vm.createContext({ window, document, console });
  vm.runInContext(SRC, ctx);
  return { card: window.SkillVisibilityCard, body };
}
const t = (k, p) => k + (p ? JSON.stringify(p) : '');
const buttons = (root) => root.findAll((e) => e.tag === 'button' && e.dataset.act === 'public');
const rows = (root) => root.findAll((e) => e.dataset.role === 'row');
const flush = () => new Promise((r) => setTimeout(r, 0));

const skills = [
  { path: 'mine', owner_id: 7, owner_name: 'Me' },
  { path: 'theirs', owner_id: 9, owner_name: 'Ann' },
  { path: 'gone', owner_id: null, missing: true },
];

test('Make public only on own skills; others show the owner; missing shows not found', () => {
  const { card, body } = load(async () => ({}));
  card.show({ skills, currentUserId: 7, onResolved() {}, t });
  const root = body.children[0];
  assert.equal(buttons(root).length, 1);
  const r = rows(root);
  assert.match(r[1].textContent, /owner/i);
  assert.match(r[1].textContent, /Ann/);
  assert.match(r[2].textContent, /notFound/);
});

test('clicking Make public asks what goes along, then calls setVisibility(path, public)', async () => {
  const calls = [];
  const { card, body } = load(async (p, v, o) => { calls.push([p, v, !!(o && o.dryRun)]); return {}; });
  card.show({ skills, currentUserId: 7, onResolved() {}, t });
  buttons(body.children[0])[0].click();
  await flush();
  assert.deepEqual(calls, [['mine', 'public', true], ['mine', 'public', false]]);   // dry run (what goes along), then the change
});

test('a clash error is shown on that row and the button stays', async () => {
  const { card, body } = load(async () => { throw Object.assign(new Error('HTTP 409'), { status: 409, data: { clash: 'different' } }); });
  card.show({ skills, currentUserId: 7, onResolved() {}, t });
  const root = body.children[0];
  buttons(root)[0].click();
  await flush();
  assert.match(rows(root)[0].textContent, /clash/);
  assert.equal(buttons(root).length, 1);
});

test('onResolved fires once when every listed skill is public, and the card closes', async () => {
  let n = 0;
  const { card, body } = load(async () => ({}));
  const two = [{ path: 'a', owner_id: 7 }, { path: 'b', owner_id: 7 }];
  const done = card.show({ skills: two, currentUserId: 7, onResolved() { n++; }, t });
  const root = body.children[0];
  buttons(root)[0].click();
  await flush();
  assert.equal(n, 0);
  buttons(root)[0].click();
  await flush();
  await done;
  assert.equal(n, 1);
  assert.equal(root.removed, true);
});

test('with a foreign or missing skill the card never resolves; Cancel closes without onResolved', async () => {
  let n = 0;
  const { card, body } = load(async () => ({}));
  const done = card.show({ skills, currentUserId: 7, onResolved() { n++; }, t });
  const root = body.children[0];
  buttons(root)[0].click();
  await flush();
  assert.equal(n, 0);
  root.find((e) => e.dataset.act === 'close').click();
  await done;
  assert.equal(n, 0);
  assert.equal(root.removed, true);
});

test('fromRefusal reads the skills of an HTTP body or an SSE event', () => {
  const { card } = load(async () => ({}));
  assert.equal(card.fromRefusal({ code: 'private_skills', data: { skills: [1] } }).length, 1);
  assert.equal(card.fromRefusal({ code: 'private_skills', skills: [1, 2] }).length, 2);
  assert.equal(card.fromRefusal({ code: 'other', skills: [1] }), null);
  assert.equal(card.fromRefusal(null), null);
});

test('Make public with required private skills: the confirmation lists them; Make public sends the real call, Cancel none', async () => {
  const calls = [];
  const set = async (p, v, o) => { calls.push([p, v, !!(o && o.dryRun)]); if (o && o.expectPublic) calls.push(['expect', ...o.expectPublic]); return { made_public: ['flow', 'pb'] }; };
  const { card, body } = load(set);
  card.show({ skills: [{ path: 'auto', owner_id: 7 }], currentUserId: 7, onResolved() {}, t });
  buttons(body.children[0])[0].click();
  await flush();
  const confirm = body.children.find((c) => c.dataset.role === 'confirm-public');
  assert.ok(confirm, 'confirmation card shown');
  assert.match(confirm.textContent, /skills\.visibility\.confirmAlso\{"name":"auto","list":"flow, pb"\}/);
  confirm.find((e) => e.dataset.act === 'cancel').click();
  await flush();
  assert.deepEqual(calls, [['auto', 'public', true]]);
  assert.equal(confirm.removed, true);

  calls.length = 0;
  const r = card.makePublic('auto', { setVisibility: set, t });
  await flush();
  const c2 = body.children.filter((c) => c.dataset.role === 'confirm-public').pop();
  c2.find((e) => e.dataset.act === 'confirm').click();
  assert.deepEqual(JSON.parse(JSON.stringify(await r)), { done: true, madePublic: ['flow', 'pb'] });
  assert.deepEqual(calls, [['auto', 'public', true], ['auto', 'public', false], ['expect', 'flow', 'pb']]);
});

test('Make public with nothing else to change: no confirmation card', async () => {
  const calls = [];
  const { card, body } = load(async (p, v, o) => { calls.push(!!(o && o.dryRun)); return { made_public: [] }; });
  const r = await card.makePublic('solo', { t });
  assert.equal(r.done, true);
  assert.deepEqual(calls, [true, false]);
  assert.equal(body.children.filter((c) => c.dataset.role === 'confirm-public').length, 0);
});
