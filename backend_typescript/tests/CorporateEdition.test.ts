/**
 * The corporate edition: twins of backend/tests/Unit/Services/EditionTest.php,
 * Unit/Controllers/SetupControllerTest.php, Unit/Controllers/AdminCorporateAccountsTest.php,
 * Unit/Controllers/LoginAdminCorporateTest.php, the sso_exchange rows of tests/sso-exchange-test.php
 * and Unit/Controllers/RobotSignInTest.php's sso case. No MySQL: the gpt users table is
 * tests/support/corporateDb's GptUsers behind the faked Kysely executor, the login service's is a
 * FakeLoginDb.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { Kysely } from 'kysely';
import { installFakeDb, queries } from './support/fakeDb';
import { GptUsers, FakeLoginDb } from './support/corporateDb';
import { db } from '../src/db/pools';
import { Edition } from '../src/Services/Edition';
import { LoginAccounts } from '../src/Services/LoginAccounts';
import { SetupController } from '../src/Controllers/SetupController';
import { AdminController } from '../src/Controllers/AdminController';
import { LoginAdminController } from '../src/Controllers/LoginAdminController';
import { AuthController } from '../src/Controllers/AuthController';
import { WebAuthnController } from '../src/Controllers/WebAuthnController';
import type { SqlConn } from '../src/Services/LoginDb';

let gpt: GptUsers;
let login: FakeLoginDb;

beforeEach(() => {
  gpt = new GptUsers();
  login = new FakeLoginDb();
  installFakeDb(gpt.handler);
});

function ctx(body: Record<string, any> = {}, userId: number | null = null, extra: Record<string, any> = {}): any {
  return { method: 'POST', uri: '/', headers: {}, query: {}, body, user_id: userId, auth_type: userId ? 'jwt' : null, params: {}, remote_addr: '', ...extra };
}

const CORP = { edition: 'corporate' };

// ---------------------------------------------------------------- Edition

test('only corporate refuses local sign in', () => {
  assert.equal(Edition.refuseLocalSignIn({}), null);
  assert.equal(Edition.refuseLocalSignIn({ edition: '' }), null);
  assert.equal(Edition.refuseLocalSignIn({ edition: 'individual' }), null);
  const refused = Edition.refuseLocalSignIn({ edition: 'corporate' })!;
  assert.equal(refused.status_code, 403);
  assert.equal(refused.success, false);
  assert.equal(refused.message, 'This installation signs in through its login service.');
});

test('isCorporate is exact', () => {
  assert.equal(Edition.isCorporate({ edition: 'corporate' }), true);
  assert.equal(Edition.isCorporate({ edition: 'Corporate' }), false);
  assert.equal(Edition.isCorporate({}), false);
});

test('local sign-in paths refuse on corporate before touching the database', async () => {
  const auth = new AuthController({ ...CORP, auth: {} });
  for (const r of [
    await auth.login(ctx({ email: 'a@b.c', password: 'x' })),
    await auth.register(ctx({ email: 'a@b.c', password: 'x', ledger_user_id: '1' })),
    await auth.firebaseAuth(ctx({ idToken: 'x' })),
    await auth.handleAction(ctx({ action: 'login', email: 'a@b.c', password: 'x' })),
    await new WebAuthnController(CORP).authenticate(ctx({ credential_id: 'c', signature: 's' })),
  ]) {
    assert.equal(r.status_code, 403);
    assert.equal(r.message, 'This installation signs in through its login service.');
  }
  assert.equal(queries.length, 0);
});

// ---------------------------------------------------------------- SetupController

/** PHP's PDO is one connection; here the pinned section runs on the faked shared instance. */
class TestSetup extends SetupController {
  protected async pinned<T>(fn: (conn: Kysely<any>) => Promise<T>): Promise<T> {
    return fn(db as Kysely<any>);
  }
}

function setup(edition = 'corporate'): SetupController {
  return new TestSetup({ edition }, new LoginAccounts(login));
}

async function create(body: Record<string, any>, edition = 'corporate') {
  return setup(edition).createAdmin(ctx(body));
}

test('status needs setup only on corporate without a person', async () => {
  assert.equal((await setup().status(ctx())).needs_setup, true);
  assert.equal((await setup('individual').status(ctx())).needs_setup, false);
  assert.equal((await setup('').status(ctx())).needs_setup, false);
  assert.equal((await setup().status(ctx())).edition, 'corporate');
});

test('the robot service user does not end first-run setup', async () => {
  gpt.add({ email: 'robot@synergyai.invalid', role: 'robot', kind: 'service' });
  assert.equal((await setup().status(ctx())).needs_setup, true);
  assert.equal((await create({ email: 'boss@corp.test', password: 'correct-horse-1' })).success, true);
});

test('createAdmin writes both databases', async () => {
  const r = await create({ email: 'boss@corp.test', password: 'correct-horse-1' });
  assert.equal(r.success, true);
  assert.equal(r.status_code, 201);
  assert.equal(r.message, 'Administrator account created');
  assert.equal(r.email, 'boss@corp.test');

  const g = gpt.byEmail('boss@corp.test')!;
  assert.equal(g.role, 'admin');
  assert.equal(g.password, null, 'gpt must not hold a password: the login service is the only credential store');
  assert.equal(Number(g.email_verified), 1);

  assert.ok(login.verifies('boss@corp.test', 'correct-horse-1'));
  assert.equal(login.byEmail('boss@corp.test')!.email_verified, 1);

  assert.equal((await setup().status(ctx())).needs_setup, false);
  assert.equal(gpt.locks, 1);
  assert.equal(gpt.unlocks, 1);
});

test('a second setup is refused', async () => {
  await create({ email: 'boss@corp.test', password: 'correct-horse-1' });
  const r = await create({ email: 'intruder@corp.test', password: 'another-pass-2' });
  assert.equal(r.status_code, 409);
  assert.equal(r.message, 'Setup is already complete');
  assert.equal(login.byEmail('intruder@corp.test'), undefined);
  assert.equal(gpt.unlocks, 2, 'the lock is released after a refusal too');
});

test('setup rejects bad input', async () => {
  const bad = await create({ email: 'not-an-email', password: 'correct-horse-1' });
  assert.equal(bad.status_code, 400);
  assert.equal(bad.message, 'Enter a valid email address');
  const short = await create({ email: 'boss@corp.test', password: 'short' });
  assert.equal(short.status_code, 400);
  assert.equal(short.message, 'The password must be at least 10 characters');
  assert.equal((await setup().status(ctx())).needs_setup, true);
});

test('setup is not available outside corporate', async () => {
  const r = await create({ email: 'boss@corp.test', password: 'correct-horse-1' }, 'individual');
  assert.equal(r.status_code, 404);
  assert.equal(r.message, 'Setup is only available in the corporate edition');
});

test('setup normalises the email in both databases', async () => {
  await create({ email: '  Boss@Corp.TEST ', password: 'correct-horse-1' });
  assert.ok(gpt.byEmail('boss@corp.test'));
  assert.ok(login.byEmail('boss@corp.test'));
});

test('a setup retried after a partial failure uses the new password', async () => {
  // A previous attempt wrote the login row, then failed before the gpt row.
  login.add({ email: 'boss@corp.test', password: bcrypt.hashSync('first-attempt-1', 4), email_verified: 0 });
  const r = await create({ email: 'boss@corp.test', password: 'second-attempt-2' });
  assert.equal(r.success, true);
  assert.ok(login.verifies('boss@corp.test', 'second-attempt-2'));
  assert.equal(login.byEmail('boss@corp.test')!.email_verified, 1);
});

test('setup is refused once any gpt person exists, even without an admin', async () => {
  // The only admin demoted themselves: a regular account remains. Setup must not reopen, or anyone
  // could overwrite that account's login password.
  gpt.add({ email: 'ann@corp.test', role: 'user' });
  login.add({ email: 'ann@corp.test', password: bcrypt.hashSync('ann-password-1', 4), email_verified: 1 });

  assert.equal((await setup().status(ctx())).needs_setup, false);
  const r = await create({ email: 'ann@corp.test', password: 'takeover-pass-2' });
  assert.equal(r.status_code, 409);
  assert.ok(login.verifies('ann@corp.test', 'ann-password-1'));
  assert.equal(gpt.byEmail('ann@corp.test')!.role, 'user');
});

test('a database without the kind column counts every user', async () => {
  gpt.noKindColumn = true;
  assert.equal((await setup().status(ctx())).needs_setup, true);
  gpt.add({ email: 'ann@corp.test', role: 'user' });
  assert.equal((await setup().status(ctx())).needs_setup, false);
});

test('a busy lock is 503 without writing or releasing', async () => {
  gpt.lockResult = 0;
  const r = await create({ email: 'boss@corp.test', password: 'correct-horse-1' });
  assert.equal(r.status_code, 503);
  assert.equal(r.message, 'Setup is busy, please try again');
  assert.equal(gpt.unlocks, 0, 'a lock that was not acquired must not be released');
  assert.equal(gpt.rows.length, 0);
  assert.equal(login.rows.length, 0);
});

test('a lock error (NULL) is busy too', async () => {
  gpt.lockResult = null;
  assert.equal((await create({ email: 'boss@corp.test', password: 'correct-horse-1' })).status_code, 503);
});

test('a missing login database is 503', async () => {
  const r = await new TestSetup(CORP, null).createAdmin(ctx({ email: 'boss@corp.test', password: 'correct-horse-1' }));
  assert.equal(r.status_code, 503);
  assert.equal(r.message, 'The login service is not configured');
  assert.equal((await setup().status(ctx())).needs_setup, true);
});

test('an unconfigured login database (no LOGIN_DB_USER) is 503 not configured', async () => {
  const c = new TestSetup({ edition: 'corporate', loginDb: { host: 'h', port: 3306, database: 'd', user: '', password: '' } } as any);
  const r = await c.createAdmin(ctx({ email: 'boss@corp.test', password: 'correct-horse-1' }));
  assert.equal(r.status_code, 503);
  assert.equal(r.message, 'The login service is not configured');
});

test('a write failure is 500 and still releases the lock', async () => {
  gpt.failInserts = true;
  const r = await create({ email: 'boss@corp.test', password: 'correct-horse-1' });
  assert.equal(r.status_code, 500);
  assert.equal(r.message, 'Could not create the administrator account');
  assert.equal(gpt.unlocks, 1);
});

// ---------------------------------------------------------------- AdminController (corporate accounts)

function admin(edition = 'corporate'): AdminController {
  return new AdminController({ edition }, new LoginAccounts(login));
}

const asAdmin = (body: Record<string, any>, params: Record<string, string> = {}) => ctx(body, 1, { params });

function seedBoss() {
  gpt.add({ id: 1, email: 'boss@corp.test', role: 'admin' });
}

test('createUser creates a verified login account and keeps no gpt password', async () => {
  seedBoss();
  const r = await admin().createUser(asAdmin({ email: 'Ann@Corp.test', password: 'ann-password-1', role: 'user' }));
  assert.equal(r.success, true);
  assert.ok(login.verifies('ann@corp.test', 'ann-password-1'));
  assert.equal(login.byEmail('ann@corp.test')!.email_verified, 1);
  const g = gpt.byEmail('ann@corp.test')!;
  assert.equal(g.password, null);
  assert.equal(g.email_verified, 1);
  assert.equal(r.user_id, g.id);
});

test('updateUser with a password changes the login password', async () => {
  seedBoss();
  await admin().createUser(asAdmin({ email: 'ann@corp.test', password: 'ann-password-1' }));
  const id = gpt.byEmail('ann@corp.test')!.id;
  const r = await admin().updateUser(asAdmin({ user_id: id, email: 'ann@corp.test', password: 'new-password-2' }));
  assert.equal(r.success, true);
  assert.ok(login.verifies('ann@corp.test', 'new-password-2'));
  assert.ok(!login.verifies('ann@corp.test', 'ann-password-1'));
  assert.equal(gpt.byEmail('ann@corp.test')!.password, null, 'gpt keeps no password on a corporate install');
});

test('an email change is refused on corporate', async () => {
  seedBoss();
  await admin().createUser(asAdmin({ email: 'ann@corp.test', password: 'ann-password-1' }));
  const id = gpt.byEmail('ann@corp.test')!.id;
  const r = await admin().updateUser(asAdmin({ user_id: id, email: 'other@corp.test' }));
  assert.equal(r.status_code, 400);
  assert.equal(r.error, 'The email of an account cannot be changed on a corporate installation');
});

test('deleteUser deletes the login account', async () => {
  seedBoss();
  await admin().createUser(asAdmin({ email: 'ann@corp.test', password: 'ann-password-1' }));
  const id = gpt.byEmail('ann@corp.test')!.id;
  const r = await admin().deleteUser(asAdmin({}, { id: String(id) }));
  assert.equal(r.success, true);
  assert.equal(login.byEmail('ann@corp.test'), undefined);
});

test('the individual edition does not touch the login database', async () => {
  seedBoss();
  await admin('individual').createUser(asAdmin({ email: 'ann@corp.test', password: 'ann-password-1' }));
  assert.equal(login.byEmail('ann@corp.test'), undefined);
  assert.notEqual(gpt.byEmail('ann@corp.test')!.password, null);
  assert.equal(gpt.byEmail('ann@corp.test')!.email_verified, 0);
});

test('a duplicate email is 409 and keeps the existing login password', async () => {
  seedBoss();
  await admin().createUser(asAdmin({ email: 'ann@corp.test', password: 'ann-password-1' }));
  const r = await admin().createUser(asAdmin({ email: 'ann@corp.test', password: 'different-password-2' }));
  assert.equal(r.success, false);
  assert.equal(r.status_code, 409);
  assert.equal(r.error, 'A user with that email already exists');
  assert.ok(login.verifies('ann@corp.test', 'ann-password-1'));
  assert.ok(!login.verifies('ann@corp.test', 'different-password-2'));
});

test('a failed gpt insert rolls back the newly created login row', async () => {
  seedBoss();
  gpt.failInserts = true;
  await assert.rejects(() => admin().createUser(asAdmin({ email: 'rollback@corp.test', password: 'rollback-password-1' })));
  assert.equal(login.byEmail('rollback@corp.test'), undefined);
});

test('explicit null accounts on corporate is 503', async () => {
  seedBoss();
  const r = await new AdminController(CORP, null).createUser(asAdmin({ email: 'noaccounts@corp.test', password: 'no-accounts-pw-1' }));
  assert.equal(r.success, false);
  assert.equal(r.status_code, 503);
  assert.equal(r.error, 'The login service is not configured');
});

test('deleting the last admin is refused', async () => {
  seedBoss();
  const r = await admin().deleteUser(asAdmin({}, { id: '1' }));
  assert.equal(r.status_code, 409);
  assert.equal(r.error, 'The last administrator cannot be removed or demoted');
  assert.equal(gpt.byId(1)!.role, 'admin');
});

test('deleting the last admin keeps its login account', async () => {
  seedBoss();
  login.add({ email: 'boss@corp.test', password: 'x', email_verified: 1 });
  await admin().deleteUser(asAdmin({}, { id: '1' }));
  assert.ok(login.byEmail('boss@corp.test'));
});

test('demoting the last admin is refused', async () => {
  seedBoss();
  const r = await admin().updateUser(asAdmin({ user_id: 1, email: 'boss@corp.test', role: 'user' }));
  assert.equal(r.status_code, 409);
  assert.equal(r.error, 'The last administrator cannot be removed or demoted');
  assert.equal(gpt.byId(1)!.role, 'admin');
});

test('updating the last admin without changing the role still works', async () => {
  seedBoss();
  let r = await admin().updateUser(asAdmin({ user_id: 1, email: 'boss@corp.test', first_name: 'Big', role: 'admin' }));
  assert.equal(r.success, true);
  r = await admin().updateUser(asAdmin({ user_id: 1, email: 'boss@corp.test', first_name: 'Bigger' }));
  assert.equal(r.success, true);
  assert.equal(gpt.byId(1)!.first_name, 'Bigger');
});

test('a non-last admin can be demoted and deleted', async () => {
  seedBoss();
  await admin().createUser(asAdmin({ email: 'ann@corp.test', password: 'ann-password-1', role: 'admin' }));
  await admin().createUser(asAdmin({ email: 'bob@corp.test', password: 'bob-password-1', role: 'admin' }));
  const ann = gpt.byEmail('ann@corp.test')!.id;
  const bob = gpt.byEmail('bob@corp.test')!.id;

  let r = await admin().updateUser(asAdmin({ user_id: ann, email: 'ann@corp.test', role: 'user' }));
  assert.equal(r.success, true);
  assert.equal(gpt.byId(ann)!.role, 'user');

  r = await admin().deleteUser(asAdmin({}, { id: String(bob) }));
  assert.equal(r.success, true);
  assert.equal(login.byEmail('bob@corp.test'), undefined);
});

test('updateUser lowercases the email', async () => {
  seedBoss();
  await admin().createUser(asAdmin({ email: 'ann@corp.test', password: 'ann-password-1' }));
  const id = gpt.byEmail('ann@corp.test')!.id;
  const r = await admin().updateUser(asAdmin({ user_id: id, email: 'Ann@Corp.test' }));
  assert.equal(r.success, true);
  assert.equal(gpt.byId(id)!.email, 'ann@corp.test');
});

// ---------------------------------------------------------------- LoginAdminController

const REFUSAL = 'Manage accounts from the Users screen on this installation';
const WRITE_ROUTES: Array<[keyof LoginAdminController, Record<string, any>]> = [
  ['createUser', { email: 'ann@corp.test' }],
  ['updateUser', { id: 2, first_name: 'Ann' }],
  ['deleteUser', { id: 2 }],
  ['setAppUserRole', { app: 'gpt', user_id: 2, role: 'user' }],
  ['addAppMember', { app: 'gpt', email: 'ann@corp.test', role: 'user' }],
];

for (const [method, body] of WRITE_ROUTES) {
  test(`login admin ${String(method)} is refused on corporate before any database access`, async () => {
    const c = new LoginAdminController(CORP) as any;
    const r = await c[method](ctx(body, 1));
    assert.equal(r.success, false);
    assert.equal(r.status_code, 403);
    assert.equal(r.error, REFUSAL);
    assert.equal(queries.length, 0);
  });

  test(`login admin ${String(method)} is not refused outside corporate`, async () => {
    seedBoss();
    for (const edition of ['individual', '']) {
      // No login_database configured: the call gets past the edition gate and the admin check,
      // and stops at the login connection.
      const c = new LoginAdminController({ edition }) as any;
      const r = await c[method](ctx(body, 1));
      assert.notEqual(r.error, REFUSAL);
      assert.equal(r.message, 'Login DB not reachable');
    }
  });
}

test('login admin reads stay allowed on corporate', async () => {
  seedBoss();
  const r = await new LoginAdminController(CORP).getUsers(ctx({}, 1));
  assert.notEqual(r.status_code, 403);
  assert.equal(r.available, false);
  assert.equal(r.message, 'Login DB not reachable — set the LOGIN_DB_* environment variables');
});

test('login admin refuses a non-admin caller', async () => {
  gpt.add({ id: 2, email: 'ann@corp.test', role: 'user' });
  const r = await new LoginAdminController({ edition: '' }).getStats(ctx({}, 2));
  assert.deepEqual(r, { success: false, error: 'Admin access required', status_code: 403 });
});

/** A login DB that records statements and answers the Login card's queries from canned rows. */
class CannedLogin implements SqlConn {
  statements: Array<[string, unknown[]]> = [];
  constructor(private readonly answer: (sql: string, p: unknown[]) => any) {}
  async select(sql: string, p: unknown[] = []) {
    this.statements.push([sql.replace(/\s+/g, ' ').trim(), p]);
    return this.answer(sql.replace(/\s+/g, ' ').trim(), p) ?? [];
  }
  async execute(sql: string, p: unknown[] = []) {
    this.statements.push([sql.replace(/\s+/g, ' ').trim(), p]);
    return this.answer(sql.replace(/\s+/g, ' ').trim(), p) ?? { insertId: 0, affectedRows: 1 };
  }
  async transaction<T>(fn: (c: SqlConn) => Promise<T>) {
    return fn(this);
  }
}

function loginAdminWith(conn: SqlConn, edition = ''): LoginAdminController {
  return new (class extends LoginAdminController {
    protected async login() {
      return conn;
    }
  })({ edition });
}

test('login admin getUsers filters, names and casts', async () => {
  seedBoss();
  const conn = new CannedLogin((q) =>
    q.startsWith('SELECT id, email, phone')
      ? [{ id: 5, email: 'ann@x.io', first_name: 'Ann', last_name: '', email_verified: '1' }, { id: 4, email: 'b@x.io', first_name: '', last_name: '', email_verified: 0 }]
      : [],
  );
  const r = await loginAdminWith(conn).getUsers(ctx({}, 1, { query: { q: ' ann ', provider: 'google' } }));
  assert.equal(r.success, true);
  assert.deepEqual(r.users.map((u: any) => [u.name, u.email_verified]), [['Ann', 1], ['b@x.io', 0]]);
  const [sqlText, params] = conn.statements[0];
  assert.match(sqlText, /WHERE \(email LIKE \? OR first_name LIKE \? OR last_name LIKE \? OR phone LIKE \?\) AND provider = \? ORDER BY id DESC LIMIT 200/);
  assert.deepEqual(params, ['%ann%', '%ann%', '%ann%', '%ann%', 'google']);
});

test('login admin deleteUser refuses the caller deleting their own account', async () => {
  seedBoss();
  const conn = new CannedLogin((q) => (q.startsWith('SELECT id, email FROM users WHERE id = ?') ? [{ id: 9, email: 'BOSS@corp.test' }] : undefined));
  const r = await loginAdminWith(conn).deleteUser(ctx({ id: 9 }, 1));
  assert.deepEqual(r, { success: false, message: "You can't delete your own account." });
});

test('login admin addAppMember creates the account and links the role', async () => {
  seedBoss();
  const conn = new CannedLogin((q) => {
    if (q.startsWith('SELECT id FROM registered_apps')) return [{ id: 3 }];
    if (q.startsWith('SELECT id FROM users WHERE email')) return [];
    if (q.startsWith('INSERT INTO users')) return { insertId: 42, affectedRows: 1 };
    return undefined;
  });
  const r = await loginAdminWith(conn).addAppMember(ctx({ app: 'gpt', email: 'new@corp.test', role: 'user' }, 1));
  assert.deepEqual(r, { success: true, created: true, user_id: 42 });
  const link = conn.statements.find(([s]) => s.startsWith('INSERT INTO app_user_roles'))!;
  assert.deepEqual(link[1], [42, 3, 'user', 1]);
});

test('login admin setAppUserRole validates the role and app', async () => {
  seedBoss();
  const conn = new CannedLogin((q) => (q.startsWith('SELECT id FROM registered_apps') ? [{ id: 3 }] : undefined));
  const la = loginAdminWith(conn);
  assert.deepEqual(await la.setAppUserRole(ctx({ app: 'gpt', user_id: 2, role: 'boss' }, 1)), { success: false, message: 'invalid role' });
  assert.deepEqual(await la.setAppUserRole(ctx({ app: 'gpt', user_id: 0, role: 'user' }, 1)), { success: false, message: 'user_id is required' });
  assert.deepEqual(await la.setAppUserRole(ctx({ app: 'gpt', user_id: 2, role: 'none' }, 1)), { success: true });
  const none = new CannedLogin(() => []);
  assert.deepEqual(await loginAdminWith(none).setAppUserRole(ctx({ app: 'zz', user_id: 2, role: 'user' }, 1)), { success: false, message: 'Unknown application' });
});

// ---------------------------------------------------------------- sso_exchange

const LOGIN_SECRET = 'login-secret-for-tests';

class TestAuth extends AuthController {
  conn: SqlConn | Error = login;
  protected async loginDbConnection(): Promise<SqlConn> {
    if (this.conn instanceof Error) throw this.conn;
    return this.conn;
  }
}

function auth(secret = LOGIN_SECRET, edition = 'corporate'): TestAuth {
  return new TestAuth({ edition, auth: { loginJwtSecret: secret } });
}

function mint(claims: Record<string, any>, secret = LOGIN_SECRET, opts: jwt.SignOptions = {}): string {
  return jwt.sign({ iss: 'login-service', type: 'access', ...claims }, secret, { algorithm: 'HS256', expiresIn: 60, ...opts });
}

const sso = (a: AuthController, token: string) => a.handleAction(ctx({ action: 'sso_exchange', login_token: token }));

test('sso_exchange: missing token and missing secret', async () => {
  assert.deepEqual(await auth().ssoExchange(ctx({})), { success: false, message: 'login_token is required', status_code: 400 });
  assert.deepEqual(await auth('').ssoExchange(ctx({ login_token: 'x' })), {
    success: false, message: 'SSO is not configured (LOGIN_JWT_SECRET missing)', status_code: 500,
  });
});

test('sso_exchange rejects garbage, wrong secret, expired, non-access and wrong issuer tokens', async () => {
  login.add({ email: 'boss@corp.test', email_verified: 1 });
  const bad = [
    'garbage',
    mint({ sub: 1 }, 'another-secret'),
    jwt.sign({ iss: 'login-service', type: 'access', sub: 1, exp: Math.floor(Date.now() / 1000) - 10 }, LOGIN_SECRET, { algorithm: 'HS256' }),
    mint({ sub: 1, type: 'refresh' }),
    mint({ sub: 1, iss: 'gpt-chat' }),
    mint({}),
  ];
  for (const t of bad) {
    assert.deepEqual(await sso(auth(), t), { success: false, message: 'Invalid SSO token', status_code: 401 });
  }
});

test('sso_exchange rejects an unknown login user', async () => {
  assert.deepEqual(await sso(auth(), mint({ sub: 77 })), { success: false, message: 'Unknown SSO user', status_code: 401 });
});

test('sso_exchange is 503 when the login DB is unreachable', async () => {
  const a = auth();
  a.conn = new Error('ECONNREFUSED');
  assert.deepEqual(await sso(a, mint({ sub: 1 })), { success: false, message: 'SSO temporarily unavailable', status_code: 503 });
});

test('sso_exchange rejects an unverified login email', async () => {
  login.add({ email: 'boss@corp.test', email_verified: 0 });
  gpt.add({ email: 'boss@corp.test', role: 'admin' });
  assert.deepEqual(await sso(auth(), mint({ sub: 1 })), { success: false, message: 'SSO account email not verified', status_code: 403 });
});

test('sso_exchange rejects a login user with no gpt account', async () => {
  login.add({ email: 'Nobody@Corp.test', email_verified: 1 });
  assert.deepEqual(await sso(auth(), mint({ sub: '1' })), {
    success: false, message: 'No account for nobody@corp.test — sign up first', status_code: 403,
  });
});

test('sso_exchange for the robot answers like no account', async () => {
  login.add({ email: 'robot@synergyai.invalid', email_verified: 1 });
  gpt.add({ email: 'robot@synergyai.invalid', role: 'robot', kind: 'service' });
  const r = await sso(auth(), mint({ sub: 1 }));
  assert.equal(r.status_code, 403);
  assert.ok(String(r.message).startsWith('No account for robot@synergyai.invalid'));
  assert.equal(r.data, undefined);
});

test('sso_exchange issues gpt tokens with the stored role, also when local sign-in is refused', async () => {
  login.add({ email: 'ann@corp.test', email_verified: 1 });
  const ann = gpt.add({ email: 'ann@corp.test', role: 'user', plan: 'standard', provider: 'email', first_name: 'Ann', last_name: 'Lee' });
  const r = await sso(auth(), mint({ sub: 1 }));
  assert.equal(r.status_code, 200);
  assert.equal(r.success, true);
  assert.equal(r.message, 'Login successful');
  assert.equal(r.data.user.id, ann.id);
  assert.equal(r.data.user.role, 'user');
  assert.equal(r.data.user.plan, 'standard');
  assert.equal(r.data.user.provider, 'sso');
  assert.equal(r.data.expires_in, 28800);
  const claims = jwt.verify(r.data.access_token, process.env.JWT_SECRET!) as any;
  assert.equal(Number(claims.sub), ann.id);
  assert.equal(claims.type, 'access');
  assert.ok(queries.some((q) => q.sql.startsWith('UPDATE users SET last_login = NOW()')));
});
