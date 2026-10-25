/**
 * WebAuthnController error-path PHP-vs-TS differential — twin of
 * backend_python/tests/differential/test_webauthn.py.
 *
 * WRITES (TS gate only; Python runs it unconditionally): the successful `authenticate` challenge
 * INSERTs a webauthn_challenges row (and purges expired ones) on each backend
 * (WebAuthnController.ts:80, :200). The DELETE targets a credential id that does not exist
 * ('diff-none' → 200 not-found message).
 *
 * TS note: the Host override goes through Node's fetch (undici), which sends a caller-set Host
 * header as given; PHP already sees Host: localhost.
 */
import { dtest, same, assert } from './harness';

dtest.write('test_challenge_and_authenticate_error_parity', async (hx) => {
  same(...(await hx.both('POST', '/api/v1/webauthn/challenge', { json: { action: 'register' }, auth: false })));
  same(...(await hx.both('POST', '/api/v1/webauthn/challenge', { json: { action: 'authenticate', credential_id: 'nope' }, auth: false })));
  same(...(await hx.both('POST', '/api/v1/webauthn/challenge', { json: { action: 'authenticate', email: 'nobody@example.invalid' }, auth: false })));
  const [a, b] = await hx.both('POST', '/api/v1/webauthn/challenge', { json: { action: 'authenticate' }, auth: false, headers: { Host: 'localhost' } });
  assert.ok(a.status === 200 && b.status === 200, `${a.status} ${b.status}\n${a.text}\n${b.text}`);
  const { challenge: _ca, ...ja } = a.json();
  const { challenge: _cb, ...jb } = b.json();
  assert.deepStrictEqual(jb, ja);
  same(...(await hx.both('POST', '/api/v1/webauthn/authenticate', { json: { credential_id: 'x' }, auth: false })));
  same(...(await hx.both('POST', '/api/v1/webauthn/authenticate', { json: { credential_id: 'nope', signature: 's' }, auth: false })));
  same(...(await hx.both('POST', '/api/v1/webauthn/register', { json: {}, auth: false }))); // 401 from middleware
  same(...(await hx.both('POST', '/api/v1/webauthn/register', { json: { credential_id: 'x' } }))); // 400
  same(...(await hx.both('DELETE', '/api/v1/webauthn/register', { json: {} }))); // 400
  same(...(await hx.both('DELETE', '/api/v1/webauthn/register', { json: { credential_id: 'diff-none' } }))); // 200 not found message
});
