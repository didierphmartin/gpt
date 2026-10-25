/**
 * UrlFetchController PHP-vs-TS differential — twin of backend_python/tests/differential/test_fetch_url.py.
 * Read-only (the live case fetches https://example.com/ from both backends).
 */
import { dtest, same, sameKeys, assert } from './harness';

dtest('test_fetch_url_validation_parity', async (hx) => {
  same(...(await hx.both('POST', '/api/v1/fetch-url', { json: {} })));
  same(...(await hx.both('POST', '/api/v1/fetch-url', { json: { url: 'not a url' } })));
  same(...(await hx.both('POST', '/api/v1/fetch-url', { json: { url: 'http://' } })));
});

dtest('test_fetch_url_live_example_com', async (hx) => {
  const [a, b] = await hx.both('POST', '/api/v1/fetch-url', { json: { url: 'https://example.com/' } });
  assert.ok(a.status === 200 && b.status === 200);
  const ja = a.json();
  const jb = b.json();
  assert.ok(ja.success === true && jb.success === true);
  sameKeys(ja, jb);
  sameKeys(ja.data, jb.data);
  assert.ok(ja.data.status === 200 && jb.data.status === 200 && ja.data.final_url === jb.data.final_url);
  assert.ok(Math.abs(ja.data.bytes - jb.data.bytes) < 64 && String(jb.data.html).includes('Example Domain'));
});
