import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { installFakeDb, queries } from './support/fakeDb';
import { WebAuthnController, WebAuthnConfig } from '../src/Controllers/WebAuthnController';
import { config } from '../src/config/env';
import { Ctx } from '../src/Support/Http';

/**
 * Twin of backend/tests/Unit/Controllers/WebAuthnSignInTest.php (and RobotSignInTest's webauthn
 * case): passkey sign-in issues a token only for a verified assertion — real keys, real signatures.
 */

type User = { id: number; email: string; first_name?: string; kind?: string; role?: string; plan?: string };
type Challenge = { challenge: string; user_id: number; action: string; age: number };

let users: User[];
let creds: { user_id: number; credential_id: string; public_key: string }[];
let challenges: Challenge[];
const keys: Record<string, crypto.KeyObject> = {};

/** A small stand-in for the users / webauthn_credentials / webauthn_challenges tables. */
function handler(q: string, p: readonly unknown[]): any {
  if (/FROM webauthn_credentials wc JOIN users/.test(q)) {
    const c = creds.find((r) => r.credential_id === p[0]);
    const u = c && users.find((r) => r.id === c.user_id);
    return c && u ? [{ public_key: c.public_key, uid: u.id, ...u }] : [];
  }
  if (/SELECT user_id FROM webauthn_credentials/.test(q)) return creds.filter((r) => r.credential_id === p[0]);
  if (/SELECT credential_id FROM webauthn_credentials/.test(q)) return creds.filter((r) => r.user_id === p[0]);
  if (/SELECT id FROM users WHERE email/.test(q)) return users.filter((r) => r.email === p[0]);
  if (/INSERT INTO webauthn_challenges/.test(q)) {
    challenges.push({ challenge: String(p[0]), user_id: Number(p[1]), action: String(p[2]), age: 0 });
    return { numAffectedRows: 1 };
  }
  if (/SELECT user_id, action, .* AS age\s+FROM webauthn_challenges/s.test(q)) return challenges.filter((r) => r.challenge === p[0]);
  if (/DELETE FROM webauthn_challenges WHERE challenge/.test(q)) {
    const before = challenges.length;
    challenges = challenges.filter((r) => r.challenge !== p[0]);
    return { numAffectedRows: before - challenges.length };
  }
  return { numAffectedRows: 0 };
}

function addCredential(userId: number, credId: string, kind: 'ec' | 'rsa'): void {
  const { publicKey, privateKey } = kind === 'ec'
    ? crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    : crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  // The DER SubjectPublicKeyInfo as base64url, as the frontend's getPublicKey() sends it.
  creds.push({ user_id: userId, credential_id: credId, public_key: publicKey.export({ format: 'der', type: 'spki' }).toString('base64url') });
  keys[credId] = privateKey;
}

beforeEach(() => {
  users = [
    { id: 1, email: 'ada@x.test', first_name: 'Ada', role: 'user', plan: 'premium' },
    { id: 2, email: 'robot@x.test', kind: 'service', role: 'robot' },
  ];
  creds = [];
  challenges = [];
  addCredential(1, 'cred-ec', 'ec');
  addCredential(1, 'cred-rsa', 'rsa');
  addCredential(2, 'cred-robot', 'ec');
  installFakeDb(handler);
});

function ctx(body: Record<string, any>, userId: number | null = null, host = 'localhost'): Ctx {
  return { method: 'POST', uri: '/', headers: { host }, query: {}, body, user_id: userId, auth_type: userId ? 'jwt' : null, params: {}, remote_addr: '127.0.0.1' } as any;
}

function controller(webauthn: WebAuthnConfig = { rp_id: 'localhost' }): WebAuthnController {
  return new WebAuthnController({ edition: '', webauthn });
}

async function challengeFor(credId: string, w = controller(), host = 'localhost'): Promise<string> {
  const r: any = await w.challenge(ctx({ action: 'authenticate', credential_id: credId }, null, host));
  assert.equal(r.success, true);
  return r.challenge;
}

type Over = { type?: string; origin?: string; rpId?: string; flags?: number; key?: crypto.KeyObject; signature?: Buffer };

/** Build and sign an assertion; `o` overrides any part. */
function assertion(credId: string, challenge: string, o: Over = {}): Record<string, string> {
  const clientData = Buffer.from(JSON.stringify({ type: o.type ?? 'webauthn.get', challenge, origin: o.origin ?? 'http://localhost', crossOrigin: false }));
  const authData = Buffer.concat([
    crypto.createHash('sha256').update(o.rpId ?? 'localhost').digest(),
    Buffer.from([o.flags ?? 0x05]),
    Buffer.from([0, 0, 0, 1]),
  ]);
  const sig = crypto.sign('sha256', Buffer.concat([authData, crypto.createHash('sha256').update(clientData).digest()]), o.key ?? keys[credId]);
  return {
    credential_id: credId,
    client_data_json: clientData.toString('base64url'),
    authenticator_data: authData.toString('base64url'),
    signature: (o.signature ?? sig).toString('base64url'),
  };
}

async function signIn(credId: string, o: Over = {}, w = controller(), host = 'localhost'): Promise<any> {
  return w.authenticate(ctx(assertion(credId, await challengeFor(credId, w, host), o), null, host));
}

function assertRefused(r: any): void {
  assert.equal(r.status_code, 401);
  assert.equal(r.success, false);
  assert.equal(r.message, 'Passkey sign-in failed');
  assert.ok(!('token' in r));
}

const now = (c: Omit<Challenge, 'age'>, age = 0) => challenges.push({ ...c, age });

test('an ES256 assertion signs in', async () => {
  const r = await signIn('cred-ec');
  assert.equal(r.success, true);
  assert.equal(r.status_code, 200);
  assert.equal((jwt.verify(r.token, config.auth.jwtSecret) as any).sub, 1);
  assert.equal(r.user.id, '1');
  assert.equal(r.user.email, 'ada@x.test');
  assert.equal(r.user.plan, 'premium');
  assert.ok(queries.some((q) => /UPDATE users SET last_login/.test(q.sql)));
  assert.equal(challenges.length, 0);
});

test('an RS256 assertion signs in', async () => {
  const r = await signIn('cred-rsa');
  assert.equal(r.success, true);
  assert.equal(r.user.id, '1');
});

test('a signature from another key is refused', async () => {
  assertRefused(await signIn('cred-ec', { key: keys['cred-rsa'] }));
});

test('a tampered signature is refused', async () => {
  assertRefused(await signIn('cred-ec', { signature: crypto.randomBytes(70) }));
});

test('a challenge never issued is refused', async () => {
  const w = controller();
  await challengeFor('cred-ec', w);
  assertRefused(await w.authenticate(ctx(assertion('cred-ec', crypto.randomBytes(32).toString('base64url')))));
});

test("another user's challenge is refused", async () => {
  now({ challenge: 'eve-challenge', user_id: 3, action: 'authenticate' });
  assertRefused(await controller().authenticate(ctx(assertion('cred-ec', 'eve-challenge'))));
  assert.equal(challenges.length, 0);
});

test('a register challenge is not a sign-in challenge', async () => {
  now({ challenge: 'reg-challenge', user_id: 1, action: 'register' });
  assertRefused(await controller().authenticate(ctx(assertion('cred-ec', 'reg-challenge'))));
});

test('the challenge is single use', async () => {
  const w = controller();
  const body = assertion('cred-ec', await challengeFor('cred-ec', w));
  assert.equal(((await w.authenticate(ctx(body))) as any).success, true);
  assertRefused(await w.authenticate(ctx(body)));
});

test('a failed attempt still consumes the challenge', async () => {
  const w = controller();
  const challenge = await challengeFor('cred-ec', w);
  assertRefused(await w.authenticate(ctx(assertion('cred-ec', challenge, { origin: 'https://evil.test' }))));
  assertRefused(await w.authenticate(ctx(assertion('cred-ec', challenge))));
});

test('an expired challenge is refused', async () => {
  now({ challenge: 'old-challenge', user_id: 1, action: 'authenticate' }, 121);
  assertRefused(await controller().authenticate(ctx(assertion('cred-ec', 'old-challenge'))));
  assert.equal(challenges.length, 0);
});

test('a wrong origin is refused', async () => {
  for (const origin of ['https://evil.test', 'http://localhost.evil.test', 'http://localhost/path', 'https://user@localhost']) {
    assertRefused(await signIn('cred-ec', { origin }));
  }
});

test('a localhost origin on any port is allowed', async () => {
  assert.equal((await signIn('cred-ec', { origin: 'http://localhost:8080' })).success, true);
});

test('off localhost the origin must be https', async () => {
  const w = controller({});
  const host = 'synergyaichat.com:443';
  const o = { rpId: 'synergyaichat.com' };
  assert.equal((await signIn('cred-ec', { ...o, origin: 'https://synergyaichat.com' }, w, host)).success, true);
  assertRefused(await signIn('cred-ec', { ...o, origin: 'http://synergyaichat.com' }, w, host));
});

test('configured origins are the only ones allowed', async () => {
  const w = controller({ rp_id: 'localhost', origins: ['chrome-extension://abc'] });
  assert.equal((await signIn('cred-ec', { origin: 'chrome-extension://abc' }, w)).success, true);
  assertRefused(await signIn('cred-ec', { origin: 'http://localhost' }, w));
});

test('a wrong rpId hash is refused', async () => {
  assertRefused(await signIn('cred-ec', { rpId: 'evil.test' }));
});

test('missing user verification or presence is refused', async () => {
  assertRefused(await signIn('cred-ec', { flags: 0x01 }));
  assertRefused(await signIn('cred-ec', { flags: 0x04 }));
});

test('a registration (webauthn.create) client data is refused', async () => {
  assertRefused(await signIn('cred-ec', { type: 'webauthn.create' }));
});

test('an unknown credential is not found', async () => {
  const r: any = await controller().authenticate(ctx({ ...assertion('cred-ec', 'x'), credential_id: 'nope' }));
  assert.equal(r.status_code, 404);
  assert.equal(r.code, 'CREDENTIAL_NOT_FOUND');
  assert.ok(!('token' in r));
});

test('a service user is not found even with a valid assertion', async () => {
  now({ challenge: 'robot-challenge', user_id: 2, action: 'authenticate' });
  const r: any = await controller().authenticate(ctx(assertion('cred-robot', 'robot-challenge')));
  assert.equal(r.status_code, 404);
  assert.equal(r.code, 'CREDENTIAL_NOT_FOUND');
  assert.ok(!('token' in r));
});

test('missing fields are a bad request', async () => {
  const full = assertion('cred-ec', 'x');
  for (const field of Object.keys(full)) {
    const body: Record<string, string> = { ...full };
    delete body[field];
    const r: any = await controller().authenticate(ctx(body));
    assert.equal(r.status_code, 400, field);
    assert.ok(!('token' in r));
  }
});

test("the email challenge lists that user's credentials and signs in", async () => {
  const r: any = await controller().challenge(ctx({ action: 'authenticate', email: 'ada@x.test' }));
  assert.equal(r.success, true);
  assert.deepEqual(r.allow_credentials.map((c: any) => c.id).sort(), ['cred-ec', 'cred-rsa']);
  assert.equal(challenges[0].user_id, 1);
  const r2: any = await controller().authenticate(ctx(assertion('cred-rsa', r.challenge)));
  assert.equal(r2.success, true);
});

test('the discoverable challenge is refused', async () => {
  const r: any = await controller().challenge(ctx({ action: 'authenticate' }));
  assert.equal(r.status_code, 400);
  assert.equal(r.code, 'EMAIL_REQUIRED');
  assert.ok(!('challenge' in r));
  assert.equal(challenges.length, 0);
});

test('the challenge for an unknown credential is not found', async () => {
  const r: any = await controller().challenge(ctx({ action: 'authenticate', credential_id: 'nope' }));
  assert.equal(r.status_code, 404);
  assert.equal(challenges.length, 0);
});

test('the register challenge still requires a signed-in user', async () => {
  assert.equal(((await controller().challenge(ctx({ action: 'register' }))) as any).status_code, 401);
  const r: any = await controller().challenge(ctx({ action: 'register' }, 5));
  assert.equal(r.success, true);
  assert.equal(r.rp_id, 'localhost');
  assert.deepEqual(r.allow_credentials, []);
  assert.match(queries[0].sql, /INSERT INTO webauthn_challenges/);
});
