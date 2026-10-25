/**
 * AuthController PHP-vs-TS differential — twin of backend_python/tests/differential/test_auth.py.
 *
 * WRITES: test_register_on_ts_login_on_php_and_vice_versa (registers two throwaway users, one per
 * backend, and deletes them by email via SQL afterwards). All other cases are validation / reads.
 */
import { randomUUID } from 'node:crypto';
import { dtest, same, sameKeys, assert } from './harness';

dtest('test_login_validation_and_bad_credentials', async (hx) => {
  same(...(await hx.both('POST', '/api/v1/auth/login', { json: { email: '', password: '' }, auth: false })));
  same(...(await hx.both('POST', '/api/v1/auth/login', { json: { email: 'nobody@example.invalid', password: 'x' }, auth: false })));
  same(...(await hx.both('POST', '/api/v1/auth/login', { json: { email: '0', password: 'x' }, auth: false })));
});

dtest('test_register_validation_matrix', async (hx) => {
  same(...(await hx.both('POST', '/api/v1/auth/register', { json: { email: 'x@y.com' }, auth: false })));
  same(...(await hx.both('POST', '/api/v1/auth/register', { json: { email: 'bad', password: 'p' }, auth: false })));
  same(...(await hx.both('POST', '/api/v1/auth/register', { json: { email: 'x@y.com', password: 'p' }, auth: false })));
});

dtest('test_legacy_action_dispatcher', async (hx) => {
  same(...(await hx.both('POST', '/api/v1/auth', { json: { action: 'nope' }, auth: false })));
  same(...(await hx.both('POST', '/api/v1/auth', { json: { action: 'logout' }, auth: false })));
  same(...(await hx.both('POST', '/api/v1/auth', { json: { action: 'upgrade_plan', plan: 'premium' }, auth: false })));
  same(...(await hx.both('POST', '/api/v1/auth', { json: { action: 'upgrade_plan', plan: 'gold' } }))); // authed, invalid plan
  same(...(await hx.both('POST', '/api/v1/auth', { json: { action: 'link_phone', phone_number: '' } })));
});

/** action as a list/dict must fall through to 'Invalid action' (400) on both sides, not a 500. */
dtest('test_legacy_action_dispatcher_non_scalar_action', async (hx) => {
  same(...(await hx.both('POST', '/api/v1/auth', { json: { action: [] }, auth: false })));
  same(...(await hx.both('POST', '/api/v1/auth', { json: { action: { a: 1 } }, auth: false })));
});

dtest('test_verify_and_logout', async (hx) => {
  same(...(await hx.both('POST', '/api/v1/auth/verify')));
  same(...(await hx.both('POST', '/api/v1/auth/verify', { headers: { Authorization: 'Bearer junk' }, auth: false })));
  same(...(await hx.both('POST', '/api/v1/auth/logout', { auth: false })));
});

dtest('test_debug_auth', async (hx) => {
  same(...(await hx.both('GET', '/api/v1/debug/auth')));
});

// Python: test_register_on_python_login_on_php_and_vice_versa.
dtest.write('test_register_on_ts_login_on_php_and_vice_versa', async (hx) => {
  const { php, ts } = hx;
  const emailA = `diff-${randomUUID().replace(/-/g, '').slice(0, 10)}@example.invalid`;
  const emailB = `diff-${randomUUID().replace(/-/g, '').slice(0, 10)}@example.invalid`;
  const body = (e: string) => ({ email: e, password: 'Pw-123456', ledger_user_id: 'diff-test', plan: 'standard' });
  try {
    const ra = await ts.post('/api/v1/auth/register', { json: body(emailA) });
    assert.equal(ra.status, 200, ra.text);
    const rb = await php.post('/api/v1/auth/register', { json: body(emailB) });
    assert.equal(rb.status, 200, rb.text);
    // shape parity (ignore ids/tokens/timestamps)
    const ua = ra.json().data.user;
    const ub = rb.json().data.user;
    sameKeys(ub, ua);
    assert.ok(ua.role === 'user' && ub.role === 'user' && ua.plan === 'standard' && ub.plan === 'standard');
    // cross-login
    const la = await php.post('/api/v1/auth/login', { json: { email: emailA, password: 'Pw-123456' } });
    const lb = await ts.post('/api/v1/auth/login', { json: { email: emailB, password: 'Pw-123456' } });
    assert.ok(la.status === 200 && lb.status === 200, `${la.text}\n${lb.text}`);
    // token interop: TS-minted token verifies on PHP and vice versa
    const ta = ra.json().data.access_token;
    const tb = rb.json().data.access_token;
    assert.equal((await php.post('/api/v1/auth/verify', { headers: { Authorization: `Bearer ${ta}` } })).json().data.user_id, ua.id);
    assert.equal((await ts.post('/api/v1/auth/verify', { headers: { Authorization: `Bearer ${tb}` } })).json().data.user_id, ub.id);
  } finally {
    await hx.primaryDb.execute('DELETE FROM users WHERE email IN (?, ?)', [emailA, emailB]);
  }
});

dtest('test_firebase_reject_parity', async (hx) => {
  same(...(await hx.both('POST', '/api/v1/auth/firebase', { json: { provider: 'google', idToken: '' }, auth: false })));
  same(...(await hx.both('POST', '/api/v1/auth/firebase', { json: { provider: 'google', idToken: '0' }, auth: false })));
  same(...(await hx.both('POST', '/api/v1/auth/firebase', { json: { provider: 'google', idToken: 'garbage' }, auth: false })));
  const forged = 'eyJhbGciOiJSUzI1NiIsImtpZCI6Im5vcGUifQ.'
    + 'eyJhdWQiOiJ0cmFuc2xlZGdlcnNpdGUiLCJpc3MiOiJodHRwczovL3NlY3VyZXRva2VuLmdvb2dsZS5jb20vdHJhbnNsZWRnZXJzaXRlIiwic3ViIjoieCJ9.'
    + 'c2ln';
  same(...(await hx.both('POST', '/api/v1/auth/firebase', { json: { provider: 'google', idToken: forged }, auth: false })));
});
