/**
 * Public / envelope PHP-vs-TS differential — twin of backend_python/tests/differential/test_public.py.
 * All read-only.
 */
import { dtest, same, assert } from './harness';

dtest('test_root', async (hx) => {
  same(...(await hx.both('GET', '/', { auth: false })));
});

dtest('test_model_catalog', async (hx) => {
  const [a, b] = await hx.both('GET', '/api/v1/models/catalog', { auth: false });
  same(a, b);
});

dtest('test_404_and_405_envelopes', async (hx) => {
  same(...(await hx.both('GET', '/api/v1/definitely-missing')));
  const [a, b] = await hx.both('PATCH', '/api/v1/prompts');
  assert.ok(a.status === 405 && b.status === 405, `php=${a.status} ts=${b.status}`);
  assert.deepStrictEqual([...b.json().allowed_methods].sort(), [...a.json().allowed_methods].sort());
});

dtest('test_401_envelopes', async (hx) => {
  same(...(await hx.both('GET', '/api/v1/prompts', { auth: false })));
  same(...(await hx.both('GET', '/api/v1/prompts', { headers: { Authorization: 'Bearer garbage' }, auth: false })));
});
