/**
 * PackageController PHP-vs-TS differential — twin of backend_python/tests/differential/test_package.py.
 * Read-only: the two PUTs are validation failures (no row is written).
 */
import { dtest, same } from './harness';

dtest('test_me_and_admin_reads', async (hx) => {
  same(...(await hx.both('GET', '/api/v1/me/package')));
  same(...(await hx.both('GET', '/api/v1/me/package', { auth: false }))); // 401 (protected route)
  same(...(await hx.both('GET', '/api/v1/admin/packages'))); // 200 for admin user 3, else 403 — same on both
  same(...(await hx.both('GET', '/api/v1/admin/packages/user')));
  same(...(await hx.both('GET', '/api/v1/admin/packages/bogus'))); // 404 route (regex [a-z]+ matches; 400 invalid role)
  same(...(await hx.both('PUT', '/api/v1/admin/packages/user', { json: {} })));
  // A string can never satisfy "capabilities object is required" — unlike the old
  // {'providers': {}} payload (which happened to fail only because 'sidebar' was
  // missing), this stays non-destructive even if the validation rules change later.
  same(...(await hx.both('PUT', '/api/v1/admin/packages/user', { json: { capabilities: 'x' } })));
});
