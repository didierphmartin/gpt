import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/fakeDb';
import { AuthController } from '../src/Controllers/AuthController';
import { MiddlewareProcessor } from '../src/Middleware/MiddlewareProcessor';
import { router } from '../src/routes';

/**
 * GET /api/v1/debug/auth (PHP AuthController::debugAuth) and GET /api/mcp-app.php, PHP's legacy
 * public alias of the MCP app proxy. No database or network: the middleware is driven with a
 * request that carries no credential.
 */

function ctx(over: Record<string, any> = {}): any {
  return { method: 'GET', uri: '/api/v1/debug/auth', headers: {}, query: {}, body: {}, user_id: null, auth_type: null, params: {}, remote_addr: '', ...over };
}

test('debugAuth reports the identity the middleware established', () => {
  const r = new AuthController().debugAuth(ctx({ user_id: 5, authenticated: true, headers: { authorization: 'Bearer t' } }));
  assert.deepEqual(r, {
    success: true, user_id: 5, authenticated: true, has_auth_header: true, php_version: '8.2.4', status_code: 200,
  });
});

test('debugAuth without an identity or header', () => {
  const r = new AuthController().debugAuth(ctx());
  assert.equal(r.user_id, null);
  assert.equal(r.authenticated, false);
  assert.equal(r.has_auth_header, false);
});

test("login and firebase treat '0' as empty, like PHP empty()", async () => {
  const auth = new AuthController();
  const login = await auth.login(ctx({ method: 'POST', body: { email: '0', password: 'x' } }));
  assert.equal(login.status_code, 400);
  assert.equal(login.message, 'Email and password are required');
  const fb = await auth.firebaseAuth(ctx({ method: 'POST', body: { provider: 'google', idToken: '0' } }));
  assert.equal(fb.status_code, 400);
  assert.equal(fb.message, 'Invalid authentication data');
});

function registered(method: string, path: string): boolean {
  return (router as any).stack.some((l: any) => l.route?.path === path && l.route.methods[method.toLowerCase()]);
}

test('both routes are registered', () => {
  assert.ok(registered('GET', '/api/v1/debug/auth'));
  assert.ok(registered('GET', '/api/mcp-app.php'));
  assert.ok(registered('GET', '/api/v1/mcp/app'));
});

/** Runs the auth middleware for a credential-less request: 'next' when it lets the request through, else the status. */
function runAuth(method: string, path: string): Promise<'next' | number> {
  const mw = new MiddlewareProcessor();
  return new Promise((resolve) => {
    const req: any = { method, path, headers: {} };
    const res: any = { status: (code: number) => ({ json: () => resolve(code) }) };
    mw.auth.handle(req, res, () => resolve('next'));
  });
}

test('/api/mcp-app.php is public (like /api/v1/mcp/app); /api/v1/debug/auth needs a credential', async () => {
  assert.equal(await runAuth('GET', '/api/mcp-app.php'), 'next');
  assert.equal(await runAuth('GET', '/api/v1/mcp/app'), 'next');
  assert.equal(await runAuth('POST', '/api/mcp-app.php'), 401);
  assert.equal(await runAuth('GET', '/api/v1/debug/auth'), 401);
});
