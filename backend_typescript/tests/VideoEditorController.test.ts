import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeDb, queries } from './support/fakeDb';
import { VideoEditorController } from '../src/Controllers/VideoEditorController';
import type { SqlConn } from '../src/Services/LoginDb';

/**
 * Twin of the VideoEditorController row of backend/tests/Unit/AdminAuthorizationTest.php (every
 * video-editor route refuses a non-admin before any database access), plus the controller's
 * request handling against canned video-edit / login connections. No MySQL: the chatbot DB is the
 * fake Kysely executor (the role lookup), the two secondary DBs are recording SqlConns.
 */

const ROLES: Record<number, string> = { 1: 'admin', 2: 'user' };

beforeEach(() => {
  installFakeDb((sql, p) => {
    if (sql === 'SELECT role FROM users WHERE id = ? LIMIT 1') {
      const role = ROLES[Number(p[0])];
      return role ? [{ role }] : [];
    }
    return [];
  });
});

function ctx(userId: number | null, query: Record<string, any> = {}, body: Record<string, any> = {}): any {
  return { method: 'GET', uri: '/', headers: {}, query, body, user_id: userId, auth_type: userId ? 'jwt' : null, params: {}, remote_addr: '' };
}

const squash = (s: string) => s.replace(/\s+/g, ' ').trim();

class Canned implements SqlConn {
  statements: Array<[string, unknown[]]> = [];
  constructor(private readonly answer: (sql: string, p: unknown[]) => any = () => undefined) {}
  async select(sql: string, p: unknown[] = []) {
    this.statements.push([squash(sql), p]);
    const out = this.answer(squash(sql), p);
    if (out instanceof Error) throw out;
    return out ?? [];
  }
  async execute(sql: string, p: unknown[] = []) {
    this.statements.push([squash(sql), p]);
    const out = this.answer(squash(sql), p);
    if (out instanceof Error) throw out;
    return { insertId: 0, affectedRows: 1 };
  }
  async transaction<T>(fn: (c: SqlConn) => Promise<T>) {
    return fn(this);
  }
}

function controllerWith(ve: SqlConn | null, login: SqlConn | null = null): VideoEditorController {
  return new (class extends VideoEditorController {
    protected async ve() {
      return ve;
    }
    protected async login() {
      return login;
    }
  })({});
}

const METHODS = [
  'getUsageStats', 'getUsageSummary', 'getUsageByUser', 'getTransactions', 'getPrices', 'savePrice',
  'getProviders', 'saveProvider', 'getModels', 'saveModel', 'getUsers', 'setUserRole', 'getPackages',
  'savePackage', 'getUserOverride', 'saveUserOverride',
] as const;

for (const m of METHODS) {
  test(`video editor ${m} refuses a plain user before any database access`, async () => {
    const ve = new Canned();
    const r = await (controllerWith(ve, ve) as any)[m](ctx(2));
    assert.deepEqual(r, { success: false, error: 'Admin access required', status_code: 403 });
    assert.deepEqual(queries.map((q) => q.sql), ['SELECT role FROM users WHERE id = ? LIMIT 1']);
    assert.deepEqual(ve.statements, []);
  });

  test(`video editor ${m} refuses an unauthenticated caller`, async () => {
    const r = await (controllerWith(null) as any)[m](ctx(null));
    assert.deepEqual(r, { success: false, error: 'Authentication required', status_code: 401 });
  });
}

test('unconfigured databases answer PHP\'s not-reachable shapes', async () => {
  const c = new VideoEditorController({});
  assert.deepEqual(await c.getUsageStats(ctx(1)), { success: false, available: false, message: 'Video-edit usage DB not reachable' });
  assert.deepEqual(await c.getUsageByUser(ctx(1)), { success: false, available: false, users: [] });
  assert.deepEqual(await c.getTransactions(ctx(1)), { success: false, available: false, rows: [], total: 0 });
  assert.deepEqual(await c.getPrices(ctx(1)), { success: false, prices: [] });
  assert.deepEqual(await c.savePrice(ctx(1)), { success: false, message: 'DB not reachable' });
  assert.deepEqual(await c.getProviders(ctx(1)), { success: false, providers: [] });
  assert.deepEqual(await c.getModels(ctx(1)), { success: false, models: [] });
  assert.deepEqual(await c.getPackages(ctx(1)), { success: false, packages: [] });
  assert.deepEqual(await c.getUsers(ctx(1)), {
    success: false, available: false, users: [], message: 'Login DB not reachable — set LOGIN_DB_* in gpt/backend/.env',
  });
  assert.deepEqual(await c.setUserRole(ctx(1)), { success: false, message: 'Login DB not reachable' });
});

test('usage stats clamps days and returns totals, by model and daily', async () => {
  const ve = new Canned((sql) => {
    if (sql.startsWith('SELECT COUNT(*) generations, COALESCE(SUM(cost_usd),0) cost, COALESCE(SUM(prompt_tokens)')) {
      return [{ generations: 3, cost: '1.50', tokens_in: '10', tokens_out: '20', users: 2 }];
    }
    if (sql.startsWith('SELECT kind, model')) return [{ kind: 'video', model: 'm1', generations: 3, units: '5', cost: '1.50' }];
    if (sql.startsWith('SELECT DATE(created_at) day')) return [{ day: '2026-10-01', generations: 3, cost: '1.50' }];
  });
  const r = await controllerWith(ve).getUsageStats(ctx(1, { days: '9999' }));
  assert.deepEqual(r, {
    success: true, available: true, days: 365,
    totals: { generations: 3, cost: '1.50', tokens_in: '10', tokens_out: '20', users: 2 },
    byModel: [{ kind: 'video', model: 'm1', generations: 3, units: '5', cost: '1.50' }],
    daily: [{ day: '2026-10-01', generations: 3, cost: '1.50' }],
  });
  assert.deepEqual(ve.statements.map(([, p]) => p), [[365], [365], [365]]);
  const r0 = await controllerWith(new Canned()).getUsageStats(ctx(1, { days: 'abc' }));
  assert.equal(r0.days, 1);
});

test('usage query failure answers Usage query failed', async () => {
  const r = await controllerWith(new Canned(() => new Error('boom'))).getUsageStats(ctx(1));
  assert.deepEqual(r, { success: false, available: false, message: 'Usage query failed' });
});

test('usage by user attaches login names (email when no name)', async () => {
  const ve = new Canned(() => [{ user_id: 7, generations: 1, cost: '0.10' }, { user_id: 8, generations: 1, cost: '0.05' }]);
  const login = new Canned(() => [{ id: 7, email: 'a@x', first_name: 'Ann', last_name: 'Lee' }]);
  const r = await controllerWith(ve, login).getUsageByUser(ctx(1));
  assert.deepEqual(r.users, [
    { user_id: 7, generations: 1, cost: '0.10', email: 'a@x', name: 'Ann Lee' },
    { user_id: 8, generations: 1, cost: '0.05', email: null, name: null },
  ]);
  assert.deepEqual(login.statements, [['SELECT id, email, first_name, last_name FROM users WHERE id IN (?,?)', [7, 8]]]);
});

test('transactions: user filter, days window, paging', async () => {
  const ve = new Canned((sql) => (sql.startsWith('SELECT COUNT(*)') ? [{ 'COUNT(*)': 41 }] : []));
  const r = await controllerWith(ve).getTransactions(ctx(1, { user_id: '5', days: '7', page: '3', per_page: '500' }));
  assert.deepEqual(r, { success: true, available: true, rows: [], total: 41, page: 3, per_page: 100 });
  assert.deepEqual(ve.statements[0], [
    'SELECT COUNT(*) FROM video_edit_usage WHERE user_id = ? AND created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)', [5, 7]]);
  assert.match(ve.statements[1][0], /ORDER BY id DESC LIMIT \? OFFSET \?$/);
  assert.deepEqual(ve.statements[1][1], [5, 7, 100, 200]);
});

test('transactions: month filter, bad month falls back to this month, all=1 drops the period', async () => {
  const ve = new Canned(() => []);
  await controllerWith(ve).getTransactions(ctx(1, { month: '2026-02' }));
  assert.deepEqual(ve.statements[0], ["SELECT COUNT(*) FROM video_edit_usage WHERE DATE_FORMAT(created_at, '%Y-%m') = ?", ['2026-02']]);
  const ve2 = new Canned(() => []);
  await controllerWith(ve2).getTransactions(ctx(1, { month: 'feb' }));
  const d = new Date();
  assert.deepEqual(ve2.statements[0][1], [`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`]);
  const ve3 = new Canned(() => []);
  await controllerWith(ve3).getTransactions(ctx(1, { all: '1', month: '2026-02' }));
  assert.deepEqual(ve3.statements[0], ['SELECT COUNT(*) FROM video_edit_usage', []]);
  assert.deepEqual(ve3.statements[1][1], [20, 0]);
});

test('usage summary seeds video/image/music and buckets per kind', async () => {
  const ve = new Canned((sql) => {
    if (sql.startsWith('SELECT kind, COALESCE')) {
      return [{ kind: 'image', cost_today: '0.5', cost_week: '1', cost_month: '2', cost_total: '3', gen_today: '1', gen_week: '2', gen_month: '3', gen_total: 4 }];
    }
    return [{ kind: 'audio', model: 'a1', generations: 2, units: '3', cost: '0.25', last_used: '2026-10-20 10:00:00' }];
  });
  const r = await controllerWith(ve).getUsageSummary(ctx(1));
  assert.equal(r.success, true);
  assert.deepEqual(Object.keys(r.kinds), ['video', 'image', 'music', 'audio']);
  assert.deepEqual(r.kinds.image.totals, { today: 0.5, week: 1, month: 2, total: 3 });
  assert.deepEqual(r.kinds.image.counts, { today: 1, week: 2, month: 3, total: 4 });
  assert.deepEqual(r.kinds.audio.byModel, [{ model: 'a1', generations: 2, units: 3, cost: 0.25, last_used: '2026-10-20 10:00:00' }]);
  assert.deepEqual(r.kinds.video, { totals: { today: 0, week: 0, month: 0, total: 0 }, counts: { today: 0, week: 0, month: 0, total: 0 }, byModel: [] });
});

test('savePrice validates and upserts', async () => {
  const ve = new Canned();
  const c = controllerWith(ve);
  assert.deepEqual(await c.savePrice(ctx(1, {}, { model: 'm', unit: 'minute', rate: 1 })),
    { success: false, message: 'model, unit (sec|image|clip) and rate are required' });
  assert.deepEqual(await c.savePrice(ctx(1, {}, { model: ' m ', unit: 'sec' })),
    { success: false, message: 'model, unit (sec|image|clip) and rate are required' });
  assert.deepEqual(await c.savePrice(ctx(1, {}, { model: ' m ', unit: 'sec', rate: '0.25' })), { success: true });
  assert.deepEqual(ve.statements, [[
    'INSERT INTO video_edit_prices (model, unit, rate, label) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE unit=VALUES(unit), rate=VALUES(rate), label=VALUES(label)',
    ['m', 'sec', 0.25, ''],
  ]]);
});

test('getProviders prefers models_json, falls back to the legacy tables, casts flags', async () => {
  const ve = new Canned((sql) => {
    if (sql.startsWith('SELECT provider, label')) {
      return [
        { provider: 'fal', label: 'Fal', api_base: '', enabled: '1', api_key: 'k', has_key: 1, updated_at: null },
        { provider: 'old', label: 'Old', api_base: '', enabled: 0, api_key: null, has_key: 0, updated_at: null },
      ];
    }
    if (sql.startsWith('SELECT provider, models_json')) {
      return [{ provider: 'fal', models_json: '[{"model":"x","cost":1.0}]' }, { provider: 'old', models_json: '[]' }];
    }
    if (sql.startsWith('SELECT m.provider')) return [{ provider: 'old', model: 'o1', label: null, kind: 'music', unit: null, rate: null }];
  });
  const r = await controllerWith(ve).getProviders(ctx(1));
  assert.deepEqual(r.providers, [
    { provider: 'fal', label: 'Fal', api_base: '', enabled: 1, api_key: 'k', has_key: true, updated_at: null, models: [{ model: 'x', cost: 1 }] },
    { provider: 'old', label: 'Old', api_base: '', enabled: 0, api_key: null, has_key: false, updated_at: null,
      models: [{ model: 'o1', label: '', kind: 'music', cost: 0, unit: 'clip' }] },
  ]);
});

test('getProviders keeps working without models_json or legacy tables', async () => {
  const ve = new Canned((sql) => {
    if (sql.startsWith('SELECT provider, label')) return [{ provider: 'p', enabled: 1, has_key: 0 }];
    return new Error('no such column/table');
  });
  const r = await controllerWith(ve).getProviders(ctx(1));
  assert.deepEqual(r, { success: true, providers: [{ provider: 'p', enabled: 1, has_key: false, models: [] }] });
});

test('saveProvider: blank key keeps the stored key; models are cleaned and encoded as PHP does', async () => {
  const ve = new Canned();
  const c = controllerWith(ve);
  assert.deepEqual(await c.saveProvider(ctx(1, {}, { provider: '  ' })), { success: false, message: 'provider is required' });
  assert.deepEqual(await c.saveProvider(ctx(1, {}, {
    provider: 'fal', enabled: true, api_key: '  ',
    models: [{ model: ' a/b ', kind: 'image', cost: '2', client_id: 'c1', start_frame: 1 }, { model: '' }, { model: 'é', kind: 'other' }],
  })), { success: true });
  assert.deepEqual(ve.statements[0], [
    'INSERT INTO video_edit_providers (provider, label, api_base, enabled, models_json) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE label=VALUES(label), api_base=VALUES(api_base), enabled=VALUES(enabled), models_json=VALUES(models_json)',
    ['fal', 'fal', '', 1, '[{"model":"a\\/b","label":"","kind":"image","cost":2.0,"unit":"","client_id":"c1","start_frame":true},{"model":"\\u00e9","label":"","kind":"video","cost":0.0,"unit":""}]'],
  ]);
  await c.saveProvider(ctx(1, {}, { provider: 'fal', clear_key: 1 }));
  assert.deepEqual(ve.statements[1][1], ['fal', 'fal', '', 0, null]);
  assert.match(ve.statements[1][0], /\(provider, label, api_base, enabled, api_key\)/);
  await c.saveProvider(ctx(1, {}, { provider: 'fal', api_key: ' sk ', label: 'Fal' }));
  assert.deepEqual(ve.statements[2][1], ['fal', 'Fal', '', 0, 'sk']);
});

test('models: list casts enabled; save validates kind and defaults label to model', async () => {
  const ve = new Canned((sql) => (sql.startsWith('SELECT') ? [{ model: 'm', enabled: '1' }] : undefined));
  const c = controllerWith(ve);
  assert.deepEqual(await c.getModels(ctx(1)), { success: true, models: [{ model: 'm', enabled: 1 }] });
  assert.deepEqual(await c.saveModel(ctx(1, {}, { model: 'm', provider: 'p', kind: 'gif' })),
    { success: false, message: 'model, provider and kind (video|image|music) are required' });
  assert.deepEqual(await c.saveModel(ctx(1, {}, { model: 'm', provider: 'p', kind: 'video' })), { success: true });
  assert.deepEqual(ve.statements[1][1], ['m', 'p', 'video', 'm', 0]);
});

test('user override: read lists BYO providers with a key; save merges, keeps blanks, clears __clear__', async () => {
  const ve = new Canned((sql) => {
    if (sql.startsWith('SELECT capabilities, byo_keys')) return [{ capabilities: '{"video":true}', byo_keys: '{"fal":"k1","x":""}' }];
    if (sql.startsWith('SELECT byo_keys')) return [{ byo_keys: '{"fal":"k1","runway":"k2"}' }];
  });
  const c = controllerWith(ve);
  assert.deepEqual(await c.getUserOverride(ctx(1, {})), { success: false, message: 'user_id is required' });
  assert.deepEqual(await c.getUserOverride(ctx(1, { user_id: '9' })),
    { success: true, user_id: 9, capabilities: { video: true }, byo_providers: ['fal'] });
  assert.deepEqual(await c.saveUserOverride(ctx(1, {}, {
    user_id: 9, capabilities: { video: false }, byo_keys: { fal: '', runway: '__clear__', luma: 'k3' },
  })), { success: true });
  assert.deepEqual(ve.statements.at(-1)![1], [9, '{"video":false}', '{"fal":"k1","luma":"k3"}', 1]);
});

test('user override save with every key cleared stores NULL byo_keys and null capabilities', async () => {
  const ve = new Canned((sql) => (sql.startsWith('SELECT byo_keys') ? [{ byo_keys: '{"fal":"k1"}' }] : undefined));
  await controllerWith(ve).saveUserOverride(ctx(1, {}, { user_id: 9, byo_keys: { fal: '__clear__' } }));
  assert.deepEqual(ve.statements.at(-1)![1], [9, null, null, 1]);
});

test('packages: decode capabilities (bad JSON -> {}), save validates role and object', async () => {
  const ve = new Canned((sql) => (sql.startsWith('SELECT') ? [{ role: 'user', capabilities: 'nope' }, { role: 'admin', capabilities: '{"a":1}' }] : undefined));
  const c = controllerWith(ve);
  assert.deepEqual((await c.getPackages(ctx(1))).packages, [{ role: 'user', capabilities: {} }, { role: 'admin', capabilities: { a: 1 } }]);
  assert.deepEqual(await c.savePackage(ctx(1, {}, { role: 'root', capabilities: {} })), { success: false, message: 'invalid role' });
  assert.deepEqual(await c.savePackage(ctx(1, {}, { role: 'user', capabilities: 'x' })), { success: false, message: 'capabilities object is required' });
  assert.deepEqual(await c.savePackage(ctx(1, {}, { role: 'user', capabilities: {} })), { success: true });
  assert.deepEqual(ve.statements.at(-1)![1], ['user', '[]', 1]);
});

test('getUsers merges names and video-edit roles from the login DB', async () => {
  const login = new Canned((sql) => {
    if (sql.startsWith('SELECT id, email, first_name')) {
      return [{ id: 4, email: 'b@x', first_name: '', last_name: '', provider: 'email', email_verified: '1', last_login: null }];
    }
    if (sql.startsWith('SELECT id FROM registered_apps')) return [{ id: 12 }];
    if (sql.startsWith('SELECT user_id, role')) return [{ user_id: 4, role: 'admin' }];
  });
  const r = await controllerWith(null, login).getUsers(ctx(1, { q: ' bo ' }));
  assert.deepEqual(r, {
    success: true, available: true, app: 'video-edit',
    users: [{ id: 4, email: 'b@x', provider: 'email', email_verified: 1, last_login: null, name: 'b@x', ve_role: 'admin' }],
  });
  assert.deepEqual(login.statements[0][1], ['%bo%', '%bo%', '%bo%']);
  assert.deepEqual(login.statements[1], ['SELECT id FROM registered_apps WHERE app_id = ? LIMIT 1', ['video-edit']]);
});

test('setUserRole: unregistered app, validation, revoke and upsert', async () => {
  const none = new Canned(() => []);
  assert.deepEqual(await controllerWith(null, none).setUserRole(ctx(1, {}, { user_id: 4, role: 'user' })),
    { success: false, message: 'video-edit app not registered in login' });
  const login = new Canned((sql) => (sql.startsWith('SELECT id FROM registered_apps') ? [{ id: 12 }] : undefined));
  const c = controllerWith(null, login);
  assert.deepEqual(await c.setUserRole(ctx(1, {}, { role: 'user' })), { success: false, message: 'user_id is required' });
  assert.deepEqual(await c.setUserRole(ctx(1, {}, { user_id: 4, role: 'root' })), { success: false, message: 'invalid role' });
  assert.deepEqual(await c.setUserRole(ctx(1, {}, { user_id: 4, role: 'none' })), { success: true });
  assert.deepEqual(await c.setUserRole(ctx(1, {}, { user_id: 4, role: 'affiliate' })), { success: true });
  const writes = login.statements.filter(([s]) => !s.startsWith('SELECT'));
  assert.deepEqual(writes, [
    ['DELETE FROM app_user_roles WHERE user_id = ? AND app_id = ?', [4, 12]],
    ['INSERT INTO app_user_roles (user_id, app_id, role, updated_by) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE role = VALUES(role), updated_by = VALUES(updated_by)', [4, 12, 'affiliate', 1]],
  ]);
});
