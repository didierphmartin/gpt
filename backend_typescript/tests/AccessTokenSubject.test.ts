import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/fakeDb';
import jwt from 'jsonwebtoken';
import { AuthMiddleware } from '../src/Middleware/AuthMiddleware';
import { AuthController } from '../src/Controllers/AuthController';
import { config } from '../src/config/env';
import { Ctx } from '../src/Support/Http';

/**
 * Twin of backend/tests/Unit/Middleware/AccessTokenSubjectTest.php: only a gpt access token is a
 * session — not the login service's tokens (same secret), not a refresh token. Also /auth/verify.
 */

const SECRET = 'test-secret-0123456789-0123456789';

function token(claims: Record<string, unknown>, secret = SECRET): string {
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign({ iat: now, exp: now + 60, sub: 7, ...claims }, secret, { algorithm: 'HS256' });
}

test('a gpt access token is accepted', () => {
  assert.equal(AuthMiddleware.accessTokenSubject(token({ iss: 'gpt-chat', type: 'access' }), SECRET), 7);
});

test('a login-service token is refused', () => {
  assert.equal(AuthMiddleware.accessTokenSubject(token({ iss: 'login-service', type: 'access' }), SECRET), null);
});

test('a refresh token is refused', () => {
  assert.equal(AuthMiddleware.accessTokenSubject(token({ iss: 'gpt-chat', type: 'refresh' }), SECRET), null);
});

test('a token without iss/type is refused', () => {
  assert.equal(AuthMiddleware.accessTokenSubject(token({}), SECRET), null);
});

function verifyCtx(bearer: string): Ctx {
  return { method: 'GET', uri: '/auth/verify', headers: { authorization: `Bearer ${bearer}` }, query: {}, body: {}, user_id: null, auth_type: null, params: {}, remote_addr: '127.0.0.1' } as any;
}

test('/auth/verify: access token valid, refresh and login-service tokens 401', () => {
  const secret = config.auth.jwtSecret;
  const ctrl = new AuthController();
  const ok = ctrl.verify(verifyCtx(token({ iss: 'gpt-chat', type: 'access' }, secret))) as any;
  assert.equal(ok.success, true);
  assert.deepEqual(ok.data, { user_id: 7 });
  for (const bad of [token({ iss: 'gpt-chat', type: 'refresh' }, secret), token({ iss: 'login-service', type: 'access' }, secret)]) {
    const r = ctrl.verify(verifyCtx(bad)) as any;
    assert.equal(r.status_code, 401);
    assert.equal(r.message, 'Invalid or expired token');
  }
});
