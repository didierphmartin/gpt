import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Twin of backend/tests/Unit/AdminAuthorizationTest.php: every /api/v1/admin/* endpoint of
 * AdminController must refuse a caller who is not an admin. The JWT carries only `sub`, so the
 * auth middleware establishes WHO the caller is and nothing more; the role check is the
 * controller's job.
 *
 * No real database: the shared Kysely instance's executor is swapped for a fake that answers the
 * guard's role lookup from an in-memory users table and records every other query (returning no
 * rows). A refused call must therefore have run the role lookup and nothing else.
 */

for (const k of ['DB_HOST', 'DB_NAME', 'DB_USER', 'DB_PASS', 'CTX_DB_HOST', 'CTX_DB_NAME', 'CTX_DB_USER', 'CTX_DB_PASS', 'JWT_SECRET']) {
  process.env[k] ||= 'x';
}

const ROLES: Record<number, string> = { 1: 'admin', 2: 'user', 3: 'guest' };
let queries: string[] = [];

let AdminController: typeof import('../src/Controllers/AdminController').AdminController;

before(() => {
  const pools: typeof import('../src/db/pools') = require('../src/db/pools');
  // Patch the executor instance itself: Kysely's executors keep private fields, so a wrapper
  // object (Object.create) cannot stand in for one.
  const executor: any = pools.db.getExecutor();
  executor.executeQuery = async (compiled: { sql: string; parameters: readonly unknown[] }) => {
    queries.push(compiled.sql);
    if (compiled.sql === 'SELECT role FROM users WHERE id = ? LIMIT 1') {
      const role = ROLES[Number(compiled.parameters[0])];
      return { rows: role ? [{ role }] : [] };
    }
    return { rows: [] };
  };
  AdminController = require('../src/Controllers/AdminController').AdminController;
});

beforeEach(() => {
  queries = [];
});

function ctx(userId: number | null, body: Record<string, any> = {}, params: Record<string, string> = {}): any {
  return { method: 'GET', uri: '/', headers: {}, query: {}, body, user_id: userId, auth_type: userId ? 'jwt' : null, params, remote_addr: '' };
}

/** Every guarded AdminController method — the same 34 as PHP — with a plausible request. */
const ENDPOINTS: Array<[string, Record<string, any>, Record<string, string>]> = [
  ['listUsers', {}, {}],
  ['getUser', {}, { id: '1' }],
  ['getUserAccount', {}, { id: '1' }],
  ['createUser', { email: 'x@y.z', password: 'pw', role: 'admin' }, {}],
  ['updateUser', { user_id: 1, role: 'admin' }, {}],
  ['deleteUser', {}, { id: '1' }],
  ['getProviderSettings', {}, { id: '1' }],
  ['saveProvider', { provider_key: 'claude' }, {}],
  ['toggleCategoryEnabled', {}, {}],
  ['toggleProviderEnabled', {}, {}],
  ['deleteProvider', {}, {}],
  ['getApiKeys', {}, { id: '1' }],
  ['saveApiKeys', { user_id: 1, keys: [] }, {}],
  ['deleteApiKey', {}, {}],
  ['getUsageStats', {}, {}],
  ['getUsageByUser', {}, {}],
  ['getUserUsageDetail', {}, { id: '1' }],
  ['getUsageTransactions', {}, {}],
  ['getToolStats', {}, {}],
  ['listMCPServers', {}, {}],
  ['createMCPServer', { name: 'x', url: 'http://x' }, {}],
  ['updateMCPServer', {}, {}],
  ['toggleMCPServer', {}, {}],
  ['deleteMCPServer', {}, { id: '1' }],
  ['refreshMCPServerTools', {}, {}],
  ['getUserMCPServers', {}, { id: '1' }],
  ['setUserMCPOverride', {}, { id: '1', serverId: '1' }],
  ['clearUserMCPOverride', {}, { id: '1', serverId: '1' }],
  ['getCosts', {}, {}],
  ['refreshAllCosts', {}, {}],
  ['refreshProviderCosts', {}, {}],
  ['getUserCosts', {}, { id: '1' }],
  ['getExchangeRates', {}, {}],
  ['refreshExchangeRates', {}, {}],
];

test('the endpoint list names 34 real AdminController methods (the set PHP guards)', () => {
  assert.equal(ENDPOINTS.length, 34);
  for (const [name] of ENDPOINTS) {
    assert.equal(typeof (AdminController.prototype as any)[name], 'function', `AdminController.${name} is missing`);
  }
});

for (const [method, body, params] of ENDPOINTS) {
  test(`plain user is refused: ${method}`, async () => {
    const result = await (new AdminController() as any)[method](ctx(2, body, params));
    assert.deepEqual(result, { success: false, error: 'Admin access required', status_code: 403 },
      `AdminController.${method}() let a role='user' caller through`);
    assert.deepEqual(queries, ['SELECT role FROM users WHERE id = ? LIMIT 1']);
  });

  test(`unauthenticated caller is refused: ${method}`, async () => {
    const result = await (new AdminController() as any)[method](ctx(null, body, params));
    assert.deepEqual(result, { success: false, error: 'Authentication required', status_code: 401 });
    assert.deepEqual(queries, []);
  });
}

test('a plain user cannot create an admin account (no write reaches the database)', async () => {
  await new AdminController().createUser(ctx(2, { email: 'escalated@test', password: 'pw', role: 'admin' }));
  assert.ok(!queries.some((q) => /^\s*INSERT/i.test(q)), 'a non-admin reached the INSERT');
});

test('a role that is neither admin nor user is refused', async () => {
  const result = await new AdminController().listUsers(ctx(3));
  assert.equal(result.status_code, 403);
});

test('a token whose subject no longer exists is refused', async () => {
  const result = await new AdminController().listUsers(ctx(999));
  assert.equal(result.status_code, 403, 'a JWT for a deleted user was accepted');
});

test('an admin passes the guard', async () => {
  const result = await new AdminController().listUsers(ctx(1));
  assert.notEqual(result.status_code, 403, 'the guard locked out a real admin');
  assert.notEqual(result.status_code, 401);
  assert.equal(result.success, true);
  assert.equal(queries.length, 2, 'the users list query ran after the guard');
});
