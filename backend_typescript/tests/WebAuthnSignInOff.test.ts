import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeDb, queries } from './support/fakeDb';
import { WebAuthnController } from '../src/Controllers/WebAuthnController';
import { Ctx } from '../src/Support/Http';

/**
 * Twin of backend/tests/Unit/Controllers/WebAuthnSignInOffTest.php (and RobotSignInTest's webauthn
 * case): passkey sign-in is off until assertions are verified — no token, and no credential ids
 * handed out by email.
 */

beforeEach(() => installFakeDb(() => []));

const HOSTED = { edition: '' } as any;

function ctx(body: Record<string, any>, userId: number | null = null): Ctx {
  return { method: 'POST', uri: '/', headers: {}, query: {}, body, user_id: userId, auth_type: userId ? 'jwt' : null, params: {}, remote_addr: '127.0.0.1' } as any;
}

test('authenticate never issues a token', async () => {
  const r: any = await new WebAuthnController(HOSTED).authenticate(ctx({
    credential_id: 'cred-1', signature: 'x', authenticator_data: 'x', client_data_json: 'x',
  }));
  assert.equal(r.code, 'PASSKEY_SIGNIN_OFF');
  assert.equal(r.status_code, 503);
  assert.equal(r.success, false);
  assert.equal(r.message, 'Passkey sign-in is turned off for now. Sign in with your email and password.');
  assert.ok(!('token' in r));
  assert.equal(queries.length, 0);
});

test('the sign-in challenge hands out no credential ids', async () => {
  const w = new WebAuthnController(HOSTED);
  for (const who of [{ email: 'admin@x.test' }, { credential_id: 'cred-1' }, {}]) {
    const r: any = await w.challenge(ctx({ action: 'authenticate', ...who }));
    assert.equal(r.code, 'PASSKEY_SIGNIN_OFF');
    assert.ok(!('allow_credentials' in r));
    assert.ok(!('challenge' in r));
  }
  assert.equal(queries.length, 0);
});

test('the register challenge still requires a signed-in user', async () => {
  const r: any = await new WebAuthnController(HOSTED).challenge(ctx({ action: 'register' }));
  assert.equal(r.status_code, 401);
});

test('a signed-in register challenge is stored and lists no credentials', async () => {
  const r: any = await new WebAuthnController(HOSTED).challenge(ctx({ action: 'register' }, 5));
  assert.equal(r.success, true);
  assert.deepEqual(r.allow_credentials, []);
  assert.equal(queries.length, 1);
  assert.match(queries[0].sql, /INSERT INTO webauthn_challenges/);
});
