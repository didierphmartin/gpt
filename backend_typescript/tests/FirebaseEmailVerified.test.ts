import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { installFakeDb } from './support/fakeDb';
import { AuthController } from '../src/Controllers/AuthController';
import { config } from '../src/config/env';
import { Ctx } from '../src/Support/Http';

/**
 * Twin of backend/tests/Unit/Controllers/FirebaseEmailVerifiedTest.php: Firebase sign-in reaches an
 * existing account by email only when Firebase verified that email (own firebase_uid, the imported
 * local-<id> user and a matching phone excepted).
 */

let d: DatabaseSync;

beforeEach(() => {
  d = new DatabaseSync(':memory:');
  d.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE, password TEXT,
    first_name TEXT, last_name TEXT, role TEXT, plan TEXT DEFAULT 'free', provider TEXT, kind TEXT NOT NULL DEFAULT 'person',
    email_verified INTEGER DEFAULT 0, firebase_uid TEXT, phone TEXT, ledger_user_id TEXT, last_login TEXT,
    app_key_hash TEXT, app_key_prefix TEXT, app_key_created_at TEXT, created_at TEXT, updated_at TEXT)`);
  d.exec(`INSERT INTO users (id, email, role, plan, firebase_uid, phone) VALUES
    (1, 'boss@x.test', 'admin', 'premium', NULL, NULL), (2, 'own@x.test', 'user', 'free', 'uid-own', NULL),
    (3, 'tel@x.test', 'user', 'free', NULL, '+15550001')`);
  installFakeDb((sqlText, params) => {
    const st = d.prepare(sqlText);
    const ps = params.map((p) => (typeof p === 'boolean' ? (p ? 1 : 0) : p)) as any[];
    if (/^\s*(select|with)\b/i.test(sqlText)) return st.all(...ps) as any[];
    const r = st.run(...ps);
    return { rows: [], insertId: Number(r.lastInsertRowid), numAffectedRows: Number(r.changes) };
  });
});

async function signIn(claims: Record<string, unknown>): Promise<any> {
  const c: any = new AuthController({ ...config, edition: '' } as any);
  c.verifyFirebaseIdToken = async () => claims;
  const ctx = { method: 'POST', uri: '/', headers: {}, query: {}, body: { idToken: 'x', provider: 'password' }, user_id: null, auth_type: null, params: {}, remote_addr: '127.0.0.1' } as unknown as Ctx;
  return c.firebaseAuth(ctx);
}

const uidOf = (id: number) => (d.prepare('SELECT firebase_uid FROM users WHERE id = ?').get(id) as any).firebase_uid;

test('an unverified email does not reach an existing account', async () => {
  for (const extra of [{}, { email_verified: false }]) {
    const r = await signIn({ sub: 'uid-attacker', email: 'boss@x.test', ...extra });
    assert.equal(r.code, 'EMAIL_NOT_VERIFIED');
    assert.equal(r.status_code, 401);
    assert.equal(r.message, 'Verify your email address first, then sign in again.');
    assert.ok(!('data' in r));
  }
  assert.equal(uidOf(1), null);
});

test('a verified email links and signs in', async () => {
  const r = await signIn({ sub: 'uid-boss', email: 'boss@x.test', email_verified: true });
  assert.equal(r.success, true);
  assert.equal(uidOf(1), 'uid-boss');
});

test('the imported firebase user of the row signs in unverified', async () => {
  const r = await signIn({ sub: 'local-1', email: 'boss@x.test' });
  assert.equal(r.success, true);
});

test('the account\'s own firebase user signs in unverified', async () => {
  const r = await signIn({ sub: 'uid-own', email: 'own@x.test' });
  assert.equal(r.success, true);
});

test('a matching phone number signs in unverified', async () => {
  const r = await signIn({ sub: 'uid-tel', phone_number: '+15550001' });
  assert.equal(r.success, true);
  assert.equal(r.data.user.id, 3);
});
