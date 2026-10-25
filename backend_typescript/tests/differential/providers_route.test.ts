/**
 * GET /api/v1/providers and the switch routes: exact JSON parity vs live PHP (no LLM calls) —
 * twin of backend_python/tests/differential/test_providers_route.py. Read-only: `switch` only
 * validates the provider and echoes it (ProviderController.switch writes nothing).
 */
import { dtest, same } from './harness';

dtest('test_list_exact', async (hx) => {
  same(...(await hx.both('GET', '/api/v1/providers')));
});

dtest('test_list_requires_auth', async (hx) => {
  same(...(await hx.both('GET', '/api/v1/providers', { auth: false })));
});

dtest('test_switch_missing_invalid_and_valid', async (hx) => {
  same(...(await hx.both('POST', '/api/v1/providers/switch', { json: {} })));
  same(...(await hx.both('POST', '/api/v1/providers/switch', { json: { provider: 'no-such-provider' } })));
  same(...(await hx.both('POST', '/api/v1/providers/switch', { json: { provider: 'kimi' } })));
  same(...(await hx.both('POST', '/api/v1/providers', { json: { provider: 'claude' } }))); // legacy POST alias
});
