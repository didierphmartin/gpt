import { test, before } from 'node:test';
import assert from 'node:assert/strict';

// The modules import the db pools (lazy connections, but config needs env vars): dummy values, set before the import.
for (const k of ['DB_HOST', 'DB_NAME', 'DB_USER', 'DB_PASS', 'CTX_DB_HOST', 'CTX_DB_NAME', 'CTX_DB_USER', 'CTX_DB_PASS', 'JWT_SECRET']) {
  process.env[k] ||= 'x';
}

let RS: typeof import('../src/Services/RoleStore');
let RP: typeof import('../src/Services/RobotPolicy');
let ED: typeof import('../src/Services/Edition');
let RA: typeof import('../src/Services/RobotAccount');
let PS: typeof import('../src/Playbook/PlaybookStore');
let RR: typeof import('../src/Support/RoleKeyRoute');
let AC: typeof import('../src/Controllers/AuthController');
before(async () => {
  RS = await import('../src/Services/RoleStore');
  RP = await import('../src/Services/RobotPolicy');
  ED = await import('../src/Services/Edition');
  RA = await import('../src/Services/RobotAccount');
  PS = await import('../src/Playbook/PlaybookStore');
  RR = await import('../src/Support/RoleKeyRoute');
  AC = await import('../src/Controllers/AuthController');
});

// ---- RoleStore (pure parts) -------------------------------------------------

test('role key format: lowercase words and digits joined by single dashes, at most 64', () => {
  const ok = RS.RoleStore.isValidKey;
  assert.ok(ok('ops'));
  assert.ok(ok('ops-team-2'));
  assert.ok(ok('a'.repeat(64)));
  assert.ok(!ok('a'.repeat(65)));
  for (const bad of ['', 'Ops', '-a', 'a-', 'a--b', 'a_b', 'a b', 'ops\n']) assert.ok(!ok(bad), bad);
});

test('built-in roles', () => {
  assert.deepEqual(RS.RoleStore.BUILTIN, ['guest', 'prospect', 'user', 'admin', 'robot']);
});

test('shapeRole: name falls back to the capitalised key; built-ins are built-in; capabilities decoded', () => {
  assert.deepEqual(RS.shapeRole({ role: 'user', name: null, builtin: 0, capabilities: '{"a":1}' }, 2),
    { role: 'user', name: 'User', builtin: true, capabilities: { a: 1 }, used_by: 2 });
  assert.deepEqual(RS.shapeRole({ role: 'ops', name: '  Operations ', builtin: 0, capabilities: { use_robot: true } }, 0),
    { role: 'ops', name: 'Operations', builtin: false, capabilities: { use_robot: true }, used_by: 0 });
  assert.deepEqual(RS.shapeRole({ role: 'x', name: '', builtin: 1, capabilities: 'not json' }, 0).capabilities, {});
  assert.equal(RS.shapeRole({ role: 'x', name: '', builtin: 1, capabilities: '[]' }, 0).builtin, true);
});

test('sortRoles: built-ins in BUILTIN order first, then custom by name then key', () => {
  const r = (role: string, name: string, builtin = false) => ({ role, name, builtin, capabilities: {}, used_by: 0 });
  const sorted = RS.sortRoles([r('zeta', 'Alpha'), r('admin', 'Admin', true), r('beta', 'Beta'), r('alpha', 'Alpha'), r('guest', 'Guest', true), r('robot', 'Robot', true)]);
  assert.deepEqual(sorted.map((x) => x.role), ['guest', 'admin', 'robot', 'alpha', 'zeta', 'beta']);
});

test('cleanRoleName trims and refuses empty or > 100 characters (invalid_name 422)', () => {
  assert.equal(RS.cleanRoleName('  Ops  '), 'Ops');
  for (const bad of ['', '   ', 'é'.repeat(101)]) {
    assert.throws(() => RS.cleanRoleName(bad), (e: any) =>
      e instanceof RS.RoleStoreError && e.kind === 'invalid_name' && e.status === 422 &&
      e.message === 'Role name is required (at most 100 characters)');
  }
  assert.equal(RS.cleanRoleName('é'.repeat(100)), 'é'.repeat(100));
});

// ---- Edition / RobotPolicy --------------------------------------------------

test('Edition reads the config it is given', () => {
  assert.equal(ED.Edition.current({ edition: 'corporate' }), 'corporate');
  assert.equal(ED.Edition.current({ edition: '' }), '');
  assert.equal(ED.Edition.current({}), '');
  assert.ok(ED.Edition.isCorporate({ edition: 'corporate' }));
  assert.ok(!ED.Edition.isCorporate({ edition: 'individual' }));
});

function fakeResolver(role: string, capabilities: Record<string, any>) {
  return {
    resolveRole: async () => role,
    resolveForUser: async () => ({ role, capabilities, updated_at: null }),
  };
}

test('RobotPolicy on Individual: everyone may use and manage', async () => {
  const p = new RP.RobotPolicy({ edition: 'individual' }, fakeResolver('guest', {}));
  assert.equal(await p.canUse(7), true);
  assert.equal(await p.canManage(7), true);
});

test('RobotPolicy on Corporate and Hosted: use = role use_robot (true only), manage = admin', async () => {
  for (const edition of ['corporate', '']) {
    const cfg = { edition };
    assert.equal(await new RP.RobotPolicy(cfg, fakeResolver('ops', { use_robot: true })).canUse(1), true);
    assert.equal(await new RP.RobotPolicy(cfg, fakeResolver('ops', { use_robot: 1 })).canUse(1), false);
    assert.equal(await new RP.RobotPolicy(cfg, fakeResolver('user', {})).canUse(1), false);
    assert.equal(await new RP.RobotPolicy(cfg, fakeResolver('ops', { use_robot: true })).canManage(1), false);
    assert.equal(await new RP.RobotPolicy(cfg, fakeResolver('admin', {})).canManage(1), true);
  }
});

// ---- RobotAccount / sign-in rules -------------------------------------------

test('RobotAccount constants and the service-row test', () => {
  assert.equal(RA.RobotAccount.EMAIL, 'robot@synergyai.invalid');
  assert.equal(RA.RobotAccount.NAME, 'SynergyAI Operations');
  assert.equal(RA.RobotAccount.ROLE, 'robot');
  assert.equal(RA.isServiceUser({ kind: 'service' }), true);
  assert.equal(RA.isServiceUser({ kind: 'person' }), false);
  assert.equal(RA.isServiceUser({}), false); // a database not migrated yet: everyone is a person
  assert.equal(RA.isServiceUser(null), false);
});

test('a paid-plan re-sign-in promotes only guest/prospect', () => {
  assert.equal(AC.promotesOnPlanUpgrade('guest'), true);
  assert.equal(AC.promotesOnPlanUpgrade('prospect'), true);
  for (const r of ['user', 'admin', 'ops', 'robot', '', null]) assert.equal(AC.promotesOnPlanUpgrade(r), false);
});

// ---- Publishing (pure decision) ---------------------------------------------

test('publishPlan: first publish takes a free key', () => {
  assert.deepEqual(PS.publishPlan(5, null, null, false), { targetId: null, deleteId: null });
});

test('publishPlan: republish updates our own copy in place', () => {
  assert.deepEqual(PS.publishPlan(5, 40, null, false), { targetId: 40, deleteId: null });
});

test('publishPlan: a key held by another source is refused unless confirmed', () => {
  const holder = { id: 41, source_id: 9 };
  assert.equal(PS.publishPlan(5, null, holder, false), 'replaces');
  assert.equal(PS.publishPlan(5, 40, holder, false), 'replaces');
  assert.equal(PS.publishPlan(5, null, { id: 41, source_id: null }, false), 'replaces');
  // confirmed, no copy of ours yet: take over the holder's row
  assert.deepEqual(PS.publishPlan(5, null, holder, true), { targetId: 41, deleteId: null });
  // confirmed, our copy exists elsewhere (key renamed): the holder goes, ours moves onto the key
  assert.deepEqual(PS.publishPlan(5, 40, holder, true), { targetId: 40, deleteId: 41 });
});

test('publishPlan: a holder from the same source with no own copy is ours', () => {
  assert.deepEqual(PS.publishPlan(5, null, { id: 41, source_id: 5 }, false), { targetId: 41, deleteId: null });
});

test('personName: first + last, else the email, else empty', () => {
  assert.equal(PS.personName({ email: 'a@b.c', first_name: ' Ann ', last_name: 'Lee' }), 'Ann Lee');
  assert.equal(PS.personName({ email: 'a@b.c', first_name: '', last_name: null }), 'a@b.c');
  assert.equal(PS.personName(undefined), '');
});

test('PlaybookStoreError carries optional data', () => {
  const e = new PS.PlaybookStoreError('replaces', 'm', 409, { published_by: 'Ann', published_at: 't' });
  assert.deepEqual(e.data, { published_by: 'Ann', published_at: 't' });
  assert.deepEqual(new PS.PlaybookStoreError('not_found', 'm', 404).data, {});
});

// ---- Routes -----------------------------------------------------------------

test('role-key route: case-sensitive, the role key format only', () => {
  const re = RR.roleKeyPath('/api/v1/admin/roles');
  const key = (p: string) => re.exec(p)?.[1] ?? null;
  assert.equal(key('/api/v1/admin/roles/ops'), 'ops');
  assert.equal(key('/api/v1/admin/roles/ops-team-2'), 'ops-team-2');
  assert.equal(key('/api/v1/admin/roles/ops/'), 'ops');
  for (const bad of ['/api/v1/admin/roles', '/api/v1/admin/roles/', '/api/v1/admin/roles/Ops', '/api/v1/admin/roles/a--b',
    '/api/v1/admin/roles/-a', '/api/v1/admin/roles/a-', '/api/v1/admin/roles/a/b', '/x/api/v1/admin/roles/a']) {
    assert.equal(key(bad), null, bad);
  }
});

test('Express routes a role key (RegExp route) and the controller sees it as params.role', async () => {
  const express = (await import('express')).default;
  const { handle } = await import('../src/Support/Http');
  const app = express();
  app.get('/api/v1/admin/packages', handle(() => ({ list: true })));
  app.get(RR.roleKeyPath('/api/v1/admin/packages'), handle((ctx) => ({ role: RR.withRoleParam(ctx).params.role })));
  app.use((_q, r) => { r.status(404).json({}); });
  const srv = app.listen(0, '127.0.0.1');
  await new Promise((ok) => srv.once('listening', ok));
  try {
    const port = (srv.address() as any).port;
    const get = async (p: string) => { const r = await fetch(`http://127.0.0.1:${port}${p}`); return [r.status, await r.json()]; };
    assert.deepEqual(await get('/api/v1/admin/packages'), [200, { list: true }]);
    assert.deepEqual(await get('/api/v1/admin/packages/ops-team'), [200, { role: 'ops-team' }]);
    assert.deepEqual(await get('/api/v1/admin/packages/user2'), [200, { role: 'user2' }]);
    assert.equal((await get('/api/v1/admin/packages/Ops'))[0], 404);
    assert.equal((await get('/api/v1/admin/packages/a--b'))[0], 404);
  } finally {
    srv.close();
  }
});
